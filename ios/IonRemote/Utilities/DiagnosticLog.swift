import Foundation
import os
import UIKit

/// Thread-safe diagnostic logger with file-backed rolling storage.
///
/// Keeps the last N app sessions on disk so logs survive crashes.
/// Also maintains an in-memory ring buffer for the live DiagnosticLogView.
///
/// Each on-disk line is a single JSON object (JSONL / NDJSON) conforming to the
/// canonical Ion log schema (`docs/observability/log-schema.md`) with
/// `component == "ios"`. The desktop reads this content over the wire protocol
/// and appends it to `~/.ion/ios-diagnostic-logs.jsonl`.
///
/// Storage: `Library/Logs/diagnostics/current.log` + rotated `session-{ts}.log`
/// files. The on-device filenames keep the `.log` extension for continuity;
/// their *content* is JSONL regardless of extension.
///
/// Limits: 5 sessions max (4 rotated + current), 10 MB total cap.
///
/// Usage: `DiagnosticLog.log("connected", tag: "transport", fields: ["device": name])`
final class DiagnosticLog: @unchecked Sendable {

    static let shared = DiagnosticLog()

    /// Log severity. Mirrors the canonical schema `level` enum.
    /// Comparable: .trace < .debug < .info < .warn < .error.
    enum Level: String, Codable, Comparable {
        case trace = "TRACE"
        case debug = "DEBUG"
        case info  = "INFO"
        case warn  = "WARN"
        case error = "ERROR"

        private var order: Int {
            switch self {
            case .trace: return 0
            case .debug: return 1
            case .info:  return 2
            case .warn:  return 3
            case .error: return 4
            }
        }

        static func < (lhs: Level, rhs: Level) -> Bool { lhs.order < rhs.order }
    }

    /// Maximum entries in the in-memory ring buffer (for live view).
    private static let maxEntries = 500

    /// Maximum number of rotated session files to keep (plus current).
    /// 4 rotated + 1 current = 5 sessions total.
    private static let maxSessionFiles = 4

    /// Maximum total size of all log files combined (10 MB).
    private static let maxTotalBytes = 10_485_760

    private let lock = OSAllocatedUnfairLock(initialState: [Entry]())
    private let logger = Logger(subsystem: "com.sprague.ion.mobile", category: "diag")
    private let logDirectory: URL
    private let currentLogURL: URL
    private var fileHandle: FileHandle?
    let writeQueue = DispatchQueue(label: "com.ion.diag-writer")

    /// RFC3339Nano UTC formatter for the `ts` field.
    let tsFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    /// Compact (single-line) JSON encoder for JSONL emission.
    let jsonEncoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = []
        return e
    }()

    // MARK: - Correlation IDs (see DiagnosticLog+Schema.swift for setters)

    /// Stamped from the engine session handshake; nil until known.
    /// Access synchronized via `writeQueue`.
    private(set) var currentSessionId: String?

    /// Stamped when a conversation becomes active; nil when cleared.
    /// Access synchronized via `writeQueue`.
    private(set) var currentConversationId: String?

    /// writeQueue-internal mutators used by the schema extension setters.
    func _setSessionIdOnQueue(_ id: String?) { currentSessionId = id }
    func _setConversationIdOnQueue(_ id: String?) { currentConversationId = id }

    // MARK: - Device identity + per-line sequence

    /// Device-identity fields stamped into every emitted line's `fields` map so
    /// the central log sink can attribute lines to a specific device / OS /
    /// app build. Computed once at init (they never change during a process's
    /// lifetime) and merged in `encodeLine`. These are what the desktop cannot
    /// know — the model, OS version, and the app version/build that produced the
    /// line. The desktop injects its own half (device_id/name, desktop_host) at
    /// persist time.
    let deviceFields: [String: String]

    /// UserDefaults key for the monotonic per-line sequence high-water mark.
    /// Persisted so `seq` never resets across app launches — the desktop uses it
    /// as the exactly-once resume/dedup cursor for the incremental log pull, and
    /// a reset would make every reconnect re-ship the whole retained history.
    private static let seqDefaultsKey = "com.ion.diag.seq"

    /// Next sequence number to stamp. Loaded from UserDefaults at init, bumped
    /// per emitted line, and persisted after each bump. Access synchronized via
    /// `writeQueue` (all mutation happens on the writer).
    private var nextSeq: Int

    /// writeQueue-internal: return the next monotonic seq and advance+persist the
    /// high-water mark. Called once per emitted line from `encodeLine`.
    func _nextSeqOnQueue() -> Int {
        let seq = nextSeq
        nextSeq += 1
        UserDefaults.standard.set(nextSeq, forKey: Self.seqDefaultsKey)
        return seq
    }

    /// Compute the immutable device-identity fields once. `utsname.machine` is
    /// the hardware model identifier (e.g. `iPhone15,3`); `UIDevice` gives the OS
    /// version; the bundle gives the app version/build. Runs on the app's main
    /// actor context is not required — these are all thread-safe reads.
    private static func computeDeviceFields() -> [String: String] {
        var sysinfo = utsname()
        uname(&sysinfo)
        let machine = withUnsafeBytes(of: &sysinfo.machine) { raw -> String in
            let bytes = raw.prefix { $0 != 0 }
            return String(decoding: bytes, as: UTF8.self)
        }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let osVersion = UIDevice.current.systemVersion
        return [
            "device_model": machine,
            "app_version": version,
            "app_build": build,
            "os_version": osVersion,
        ]
    }

    struct Entry: Sendable {
        let timestamp: Date
        let message: String
        let level: Level
        let tag: String
    }

    private init() {
        let libDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        logDirectory = libDir.appendingPathComponent("Logs/diagnostics", isDirectory: true)
        currentLogURL = logDirectory.appendingPathComponent("current.log")

        // Device identity + seq cursor are established before any line is
        // written (writeSessionMarker below emits the first line, which must
        // already carry both). Seq is 1-based: a full pull uses sinceSeq=0 and
        // filters seq > 0, so the very first line (seq 1) must never be 0, or a
        // full export would silently drop it. UserDefaults returns 0 when unset,
        // so max(1, ...) yields 1 on first launch and the persisted value on
        // every subsequent launch.
        deviceFields = Self.computeDeviceFields()
        nextSeq = max(1, UserDefaults.standard.integer(forKey: Self.seqDefaultsKey))

        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        rotateIfNeeded()
        openCurrentLog()
        writeSessionMarker()
    }

    // MARK: - Public API

    /// Minimum log level. Messages below this level are discarded before
    /// writing to disk or the in-memory ring buffer. Defaults to `.info`
    /// so debug-level per-event calls (agent state, tool start/end, text
    /// delta, snapshot ticks) do not ship to the desktop log under normal
    /// operation. Set to `.debug` or `.trace` to enable verbose diagnostics.
    static var minLevel: Level = .info

    /// Append a structured diagnostic message. Emits one JSONL line to the
    /// file and echoes to os_log.
    ///
    /// - Parameters:
    ///   - msg:    Human-readable message. Do not embed structured data — use `fields`.
    ///   - tag:    Subsystem label (`session`, `ipc`, `transport`). Omitted from the
    ///             line when empty.
    ///   - level:  Severity. Defaults to `.info`.
    ///   - fields: Structured context map. Emitted as `{}` when empty.
    static func log(_ msg: String, tag: String = "", level: Level = .info, fields: [String: String] = [:]) {
        guard level >= minLevel else { return }
        shared.append(msg, tag: tag, level: level, fields: fields)
    }

    /// Convenience: log at TRACE level (below DEBUG). Use for high-frequency
    /// internal diagnostics that are too noisy at DEBUG.
    static func trace(_ msg: String, tag: String = "", fields: [String: String] = [:]) {
        guard Level.trace >= minLevel else { return }
        shared.append(msg, tag: tag, level: .trace, fields: fields)
    }

    /// Return all current in-memory entries (oldest first).
    static func entries() -> [Entry] {
        shared.lock.withLock { $0 }
    }

    /// Clear in-memory entries (file history is preserved).
    static func clear() {
        shared.lock.withLock { $0.removeAll() }
    }

    /// Format all sessions as a shareable string (oldest first).
    static func exportAllSessions() -> String {
        shared.readAllSessions()
    }

    /// Return all retained log lines whose `fields.seq` is strictly greater than
    /// `sinceSeq`. Used by the desktop's incremental log pull so repeated pulls
    /// transfer only new lines and never re-ship history already persisted.
    ///
    /// Returns `(logs: "<new JSONL lines>", nextSeq: <max seq seen + 1, or the
    /// input floor when nothing is newer>)`. The desktop advances its persisted
    /// per-device cursor to `nextSeq`.
    ///
    /// Seq-based rather than line-count-based: a line count is invalidated the
    /// moment an on-device session file rotates out (the Nth line no longer
    /// addresses the same logical entry), whereas `seq` is a monotonic per-line
    /// identity independent of file layout. Lines with no parseable `seq` (only
    /// possible from a pre-upgrade retained session) are treated as already-seen
    /// and skipped, so a mixed-schema history never re-ships.
    static func exportIncrementalSince(sinceSeq: Int) -> (logs: String, nextSeq: Int) {
        let all = shared.readAllSessions()
        let lines = all.isEmpty ? [] : all.components(separatedBy: "\n").filter { !$0.isEmpty }
        var newLines: [String] = []
        var maxSeq = sinceSeq
        for line in lines {
            guard let seq = Self.parseSeq(line) else { continue }
            if seq > sinceSeq {
                newLines.append(line)
                if seq > maxSeq { maxSeq = seq }
            }
        }
        let nextSeq = maxSeq + (newLines.isEmpty ? 0 : 1)
        let newContent = newLines.isEmpty ? "" : newLines.joined(separator: "\n") + "\n"
        return (newContent, nextSeq)
    }

    /// Extract `fields.seq` from a single JSONL line. Returns nil when the line
    /// is unparseable or carries no numeric seq (pre-upgrade lines).
    private static func parseSeq(_ line: String) -> Int? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fields = obj["fields"] as? [String: Any] else { return nil }
        if let n = fields["seq"] as? Int { return n }
        if let s = fields["seq"] as? String { return Int(s) }
        return nil
    }

    /// Format only the current session's log.
    static func exportCurrentSession() -> String {
        shared.writeQueue.sync {}
        return (try? String(contentsOf: shared.currentLogURL, encoding: .utf8)) ?? ""
    }

    /// Number of stored session files (including current).
    static func sessionCount() -> Int {
        shared.allLogFiles().count + 1 // rotated + current
    }

    /// Format current in-memory entries as a shareable string.
    static func exportText() -> String {
        shared.readAllSessions()
    }

    /// Synchronously flush pending writes to disk (used by crash handlers).
    static func flush() {
        shared.writeQueue.sync {}
        shared.fileHandle?.synchronizeFile()
    }

    // MARK: - Internal

    private func append(_ msg: String, tag: String, level: Level, fields: [String: String]) {
        logger.info("\(msg, privacy: .public)")
        let entry = Entry(timestamp: Date(), message: msg, level: level, tag: tag)
        lock.withLock { state in
            state.append(entry)
            if state.count > Self.maxEntries {
                state.removeFirst(state.count - Self.maxEntries)
            }
        }
        writeQueue.async { [weak self] in
            guard let self else { return }
            let line = self.encodeLine(entry: entry, fields: fields)
            self.writeToFile(line)
        }
    }

    private func writeToFile(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        if fileHandle == nil { openCurrentLog() }
        fileHandle?.write(data)
    }

    // MARK: - Session Rotation

    private func rotateIfNeeded() {
        let fm = FileManager.default
        guard fm.fileExists(atPath: currentLogURL.path) else { return }

        // Only rotate if the current log has content.
        let attrs = try? fm.attributesOfItem(atPath: currentLogURL.path)
        let size = attrs?[.size] as? Int ?? 0
        guard size > 0 else { return }

        // No plain-text SESSION END banner: JSONL has no banners. The file
        // boundary itself is the session separator.
        let ts = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let rotatedName = "session-\(ts).log"
        let rotatedURL = logDirectory.appendingPathComponent(rotatedName)
        try? fm.moveItem(at: currentLogURL, to: rotatedURL)

        pruneOldSessions()
    }

    private func pruneOldSessions() {
        let fm = FileManager.default
        var files = allLogFiles()

        // Sort oldest first (by filename, which embeds the timestamp).
        files.sort()

        // Prune by count: keep only the last N session files.
        while files.count > Self.maxSessionFiles {
            try? fm.removeItem(at: logDirectory.appendingPathComponent(files.removeFirst()))
        }

        // Prune by total size: include current.log in the budget.
        var totalSize = files.reduce(0) { sum, name in
            let path = logDirectory.appendingPathComponent(name).path
            let s = (try? fm.attributesOfItem(atPath: path))?[.size] as? Int ?? 0
            return sum + s
        }
        let currentSize = ((try? fm.attributesOfItem(atPath: currentLogURL.path))?[.size] as? Int) ?? 0
        totalSize += currentSize

        while totalSize > Self.maxTotalBytes, !files.isEmpty {
            let oldest = files.removeFirst()
            let path = logDirectory.appendingPathComponent(oldest).path
            let s = (try? fm.attributesOfItem(atPath: path))?[.size] as? Int ?? 0
            try? fm.removeItem(atPath: path)
            totalSize -= s
        }
    }

    /// Returns sorted names of rotated session files (not current.log).
    func allLogFiles() -> [String] {
        let fm = FileManager.default
        let contents = (try? fm.contentsOfDirectory(atPath: logDirectory.path)) ?? []
        return contents.filter { $0.hasPrefix("session-") && $0.hasSuffix(".log") }.sorted()
    }

    // MARK: - File I/O

    private func openCurrentLog() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: currentLogURL.path) {
            fm.createFile(atPath: currentLogURL.path, contents: nil)
        }
        fileHandle = try? FileHandle(forWritingTo: currentLogURL)
        fileHandle?.seekToEndOfFile()
    }

    private func writeSessionMarker() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        // Compute locally — can't call Self.sessionCount() during init (reentrancy deadlock).
        let sessions = allLogFiles().count + 1
        // Call the instance `append` directly, NOT the static `DiagnosticLog.log`:
        // we are still inside `shared`'s one-time initializer, so touching
        // `DiagnosticLog.shared` here would deadlock on dispatch_once.
        //
        // No `device` field here: the real hardware model arrives on every line
        // (including this one) as `device_model`, merged from `deviceFields` in
        // encodeLine. The old `device` field read SIMULATOR_DEVICE_NAME, which is
        // the literal string "device" on real hardware — a lie, now removed.
        append(
            "session start",
            tag: "session",
            level: .info,
            fields: [
                "version": "\(version)(\(build))",
                "os": os,
                "sessions": String(sessions),
            ]
        )
    }

    private func readAllSessions() -> String {
        var parts: [String] = []

        // Read rotated sessions (oldest first).
        for name in allLogFiles() {
            let url = logDirectory.appendingPathComponent(name)
            if let content = try? String(contentsOf: url, encoding: .utf8), !content.isEmpty {
                parts.append(content)
            }
        }

        // Read current session (flush any pending writes first).
        writeQueue.sync {}
        if let current = try? String(contentsOf: currentLogURL, encoding: .utf8), !current.isEmpty {
            parts.append(current)
        }

        return parts.joined()
    }
}
