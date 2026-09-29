import Foundation
import os
import UIKit

/// Thread-safe diagnostic logger with file-backed rolling storage.
///
/// Keeps logs on disk so they survive crashes until the paired server has
/// pulled them. Also maintains an in-memory ring buffer for the live
/// DiagnosticLogView.
///
/// Each on-disk line is a single JSON object (JSONL / NDJSON) conforming to the
/// canonical Ion log schema (`docs/observability/log-schema.md`) with
/// `component == "ios"`. The desktop reads this content over the wire protocol
/// and appends it to `~/.ion/ios-diagnostic-logs.jsonl`.
///
/// Storage: `Library/Logs/diagnostics/current.log` + rotated segment files
/// named `session-{sessionTag}-{maxSeq}.log`. The on-device filenames keep the
/// `.log` extension for continuity; their *content* is JSONL regardless of
/// extension. Rotation and retention (a segment is deleted only once its
/// server has the lines, or past a hard size cap) live in
/// DiagnosticLog+Retention.swift.
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

    /// Maximum stored bytes for a single entry's message. A runaway caller
    /// (e.g. a queue key that accidentally interpolated a multi-megabyte
    /// command payload) must never occupy megabytes in the in-memory ring
    /// buffer AND again in every exported line. Applied at entry creation so
    /// both the ring buffer and the on-disk/exported JSONL are bounded.
    static let maxMessageBytes = 4_096

    /// Marker appended to a message that was truncated at `maxMessageBytes`.
    static let truncationMarker = "…[truncated]"

    /// Truncate `msg` to at most `maxMessageBytes` UTF-8 bytes (on a character
    /// boundary), appending `truncationMarker` when truncation occurred.
    static func boundedMessage(_ msg: String) -> String {
        guard msg.utf8.count > maxMessageBytes else { return msg }
        var out = String(msg.prefix(maxMessageBytes))
        // prefix(n) counts Characters, not bytes — shrink until the byte
        // budget holds (multi-byte characters make chars < bytes).
        while out.utf8.count > maxMessageBytes {
            out = String(out.prefix(out.count - out.utf8.count + maxMessageBytes))
        }
        return out + truncationMarker
    }

    private let lock = OSAllocatedUnfairLock(initialState: [Entry]())
    // Subsystem derives from the app bundle so forks/rebrands get a correct
    // unified-logging subsystem with zero edits. (os.Logger output is
    // Console.app-only; the operator-facing log path is the JSONL file.)
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ion.mobile", category: "diag")
    /// Internal (not private) so tests can inject rotated session files to
    /// exercise the export-cursor rotation path.
    let logDirectory: URL
    let currentLogURL: URL
    var fileHandle: FileHandle?
    /// Set once a failed open of current.log has been recorded, so a log file
    /// that stays unopenable records one entry instead of one per line.
    var openFailureRecorded = false
    let writeQueue = DispatchQueue(label: "com.ion.diag-writer")

    // MARK: - Segment state (writeQueue-confined; see DiagnosticLog+Retention.swift)

    /// Tag naming this app launch's segments: `session-{sessionTag}-{maxSeq}.log`.
    var sessionTag: String = ""
    /// Bytes in `current.log`, so a write can decide to rotate without a stat.
    var currentSegmentBytes: UInt64 = 0
    /// What `current.log` holds, kept up to date on every write.
    var currentSegment = SegmentSummary(maxSeq: 0, pairingMaxSeq: [:])
    /// Summaries of rotated segments, persisted beside them so a launch never
    /// rescans a segment it has already summarized.
    var segmentIndex: [String: SegmentSummary] = [:]
    /// After a failed rotation, the size `current.log` must reach before the
    /// next attempt, so a stuck rename is retried once per segment of growth
    /// rather than on every line. 0 when the last rotation succeeded.
    var nextRotationAttemptBytes: UInt64 = 0

    // MARK: - Export cursor (writeQueue-confined)

    /// Per-file byte offset already scanned by the incremental export. Keyed by
    /// file name ("current.log" / "session-…​.log"). Bytes before the offset
    /// were parsed on a previous pull; a pull re-reads only the tail past the
    /// offset. A file with no entry (e.g. a rotation the cursor has not seen)
    /// is read from 0. Access confined to `writeQueue`.
    var exportFileOffsets: [String: UInt64] = [:]

    /// The maximum `fields.seq` observed across all bytes the cursor has
    /// skipped past. The cursor is only valid for a request whose `sinceSeq`
    /// is ≥ this value — otherwise a skipped line could qualify for the pull,
    /// so the export resets the cursor and rescans from 0. Access confined to
    /// `writeQueue`.
    var exportScannedMaxSeq: Int = 0

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

    /// UserDefaults key holding the selected pairing's device id. The logger
    /// reads it at launch so lines written before any view model exists are
    /// already attributed.
    static let selectedPairingDefaultsKey = "activeDeviceId"

    /// The paired desktop's device id. Stamped on every log line so on-device
    /// logs are attributable to a specific pairing. Nil only while no pairing
    /// is selected. Access synchronized via `writeQueue`.
    private(set) var currentPairingId: String?

    /// writeQueue-internal mutators used by the schema extension setters.
    func _setSessionIdOnQueue(_ id: String?) { currentSessionId = id }
    func _setConversationIdOnQueue(_ id: String?) { currentConversationId = id }
    func _setPairingIdOnQueue(_ id: String?) { currentPairingId = id }

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

    /// writeQueue-internal: the seq of the last line written, 0 before any.
    func _highestWrittenSeqOnQueue() -> Int { nextSeq - 1 }

    /// writeQueue-internal: never stamp a seq at or below `seq`. The persisted
    /// counter can lag the file after a crash (UserDefaults had not flushed),
    /// and a reused seq is deduplicated away by the server as already seen.
    func _raiseNextSeqOnQueue(above seq: Int) {
        guard seq >= nextSeq else { return }
        nextSeq = seq + 1
        UserDefaults.standard.set(nextSeq, forKey: Self.seqDefaultsKey)
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

        // Stable per-device hardware identity (survives re-pairings and app
        // reinstalls on the same device). identifierForVendor resets only on a
        // full device wipe, making it suitable as a durable device_id.
        let vendorId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"

        var fields: [String: String] = [
            "device_model": machine,
            "app_version": version,
            "app_build": build,
            "os_version": osVersion,
            "device_id": vendorId,
        ]

        // MDM-enrolled devices expose admin-assigned identity via the Managed
        // App Config dictionary. When present, stamp it so Intune/MDM device IDs
        // appear on every log line for cross-system correlation.
        if let managed = UserDefaults(suiteName: "com.apple.configuration.managed") {
            if let mdmId = managed.string(forKey: "MDMDeviceID"), !mdmId.isEmpty {
                fields["mdm_device_id"] = mdmId
            }
            if let mdmSerial = managed.string(forKey: "MDMSerialNumber"), !mdmSerial.isEmpty {
                fields["mdm_serial"] = mdmSerial
            }
        }

        return fields
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
        // Same ordering requirement for the pairing stamp: a line with no
        // pairing_id is never exported to any desktop.
        currentPairingId = UserDefaults.standard.string(forKey: Self.selectedPairingDefaultsKey)

        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        } catch {
            // Instance `append`, not the static `log`: `shared` is still initializing.
            append("log directory create failed", tag: "diagnostics", level: .error, fields: [
                "error": error.localizedDescription
            ])
        }
        // Storage setup runs on the writer so nothing it logs can interleave
        // with it. The previous launch's current.log becomes a segment under
        // that launch's tag before this launch takes a new one.
        writeQueue.sync {
            loadSegmentIndex()
            sessionTag = UserDefaults.standard.string(forKey: Self.sessionTagDefaultsKey)
                ?? Self.makeSessionTag(Date())
            rotateCurrentSegment(reason: "launch")
            _raiseNextSeqOnQueue(above: segmentIndex.values.map(\.maxSeq).max() ?? 0)
            sessionTag = Self.makeSessionTag(Date())
            UserDefaults.standard.set(sessionTag, forKey: Self.sessionTagDefaultsKey)
            openCurrentLog()
        }
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

    /// Format only the current app launch's log: its rotated segments, then
    /// `current.log`.
    static func exportCurrentSession() -> String {
        shared.writeQueue.sync {
            let prefix = "session-\(shared.sessionTag)-"
            var urls = shared.allLogFiles().filter { $0.hasPrefix(prefix) }
                .map { shared.logDirectory.appendingPathComponent($0) }
            urls.append(shared.currentLogURL)
            return urls.compactMap { shared.readSessionFile($0) }.joined()
        }
    }

    /// Number of app launches with lines on disk (including this one).
    static func sessionCount() -> Int {
        shared.writeQueue.sync {
            let tags = Set(shared.allLogFiles().map(sessionTag(ofSegment:)))
            return tags.subtracting([shared.sessionTag]).count + 1
        }
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

    func append(_ msg: String, tag: String, level: Level, fields: [String: String], span: SpanStamp? = nil) {
        // Bound the message BEFORE it is stored anywhere: the in-memory ring
        // buffer, the os_log echo, and the encoded JSONL line all see the
        // capped form, so no path can retain an unbounded payload.
        let bounded = Self.boundedMessage(msg)
        logger.info("\(bounded, privacy: .public)")
        let entry = Entry(timestamp: Date(), message: bounded, level: level, tag: tag)
        lock.withLock { state in
            state.append(entry)
            if state.count > Self.maxEntries {
                state.removeFirst(state.count - Self.maxEntries)
            }
        }
        writeQueue.async { [weak self] in
            guard let self else { return }
            let line = self.encodeLine(entry: entry, fields: fields, span: span)
            self.writeLine(line)
        }
    }

    // MARK: - File I/O

    /// Record a failed open of current.log. It cannot go through `append`:
    /// that schedules `writeToFile`, which retries this open and fails again,
    /// forever. So it lands in the in-memory ring buffer only, once per outage.
    func recordOpenFailure(_ error: Error) {
        guard !openFailureRecorded else { return }
        openFailureRecorded = true
        let entry = Entry(
            timestamp: Date(),
            message: "log file open failed: \(error.localizedDescription)",
            level: .error,
            tag: "diagnostics"
        )
        lock.withLock { state in
            state.append(entry)
            if state.count > Self.maxEntries {
                state.removeFirst(state.count - Self.maxEntries)
            }
        }
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

    /// Every retained segment, oldest first, then `current.log`. Runs on the
    /// writer so a rotation cannot rename a file out from under the read.
    private func readAllSessions() -> String {
        writeQueue.sync {
            var urls = allLogFiles().map { logDirectory.appendingPathComponent($0) }
            urls.append(currentLogURL)
            return urls.compactMap { readSessionFile($0) }.joined()
        }
    }

    /// Read one session file for export. A failed read drops that session
    /// from the export, so it is logged.
    func readSessionFile(_ url: URL) -> String? {
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch {
            append("log session read failed", tag: "diagnostics", level: .warn, fields: [
                "file": url.lastPathComponent,
                "error": error.localizedDescription
            ])
            return nil
        }
    }
}
