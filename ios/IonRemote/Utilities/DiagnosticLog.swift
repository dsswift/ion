import Foundation
import os

/// Thread-safe diagnostic logger with file-backed rolling storage.
///
/// Keeps the last N app sessions on disk so logs survive crashes.
/// Also maintains an in-memory ring buffer for the live DiagnosticLogView.
///
/// Storage: `Library/Logs/diagnostics/current.log` + rotated `session-{ts}.log` files.
/// Limits: 4 sessions max, 2 MB total cap.
///
/// Usage: `DiagnosticLog.log("CONNECT: device=\(name)")`
final class DiagnosticLog: @unchecked Sendable {

    static let shared = DiagnosticLog()

    /// Maximum entries in the in-memory ring buffer (for live view).
    private static let maxEntries = 500

    /// Maximum number of rotated session files to keep (plus current).
    private static let maxSessionFiles = 3

    /// Maximum total size of all log files combined (2 MB).
    private static let maxTotalBytes = 2_097_152

    private let lock = OSAllocatedUnfairLock(initialState: [Entry]())
    private let logger = Logger(subsystem: "com.sprague.ion.mobile", category: "diag")
    private let logDirectory: URL
    private let currentLogURL: URL
    private var fileHandle: FileHandle?
    private let writeQueue = DispatchQueue(label: "com.ion.diag-writer")
    private let fileDateFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    struct Entry: Sendable {
        let timestamp: Date
        let message: String
    }

    private init() {
        let libDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        logDirectory = libDir.appendingPathComponent("Logs/diagnostics", isDirectory: true)
        currentLogURL = logDirectory.appendingPathComponent("current.log")

        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        rotateIfNeeded()
        openCurrentLog()
        writeSessionMarker()
    }

    // MARK: - Public API

    /// Append a diagnostic message. Also echoes to os_log and writes to file.
    static func log(_ message: String) {
        shared.append(message)
    }

    /// Return all current in-memory entries (oldest first).
    static func entries() -> [Entry] {
        shared.lock.withLock { $0 }
    }

    /// Clear in-memory entries (file history is preserved).
    static func clear() {
        shared.lock.withLock { $0.removeAll() }
    }

    /// Format all sessions as a shareable plain-text string (oldest first).
    static func exportAllSessions() -> String {
        shared.readAllSessions()
    }

    /// Format only the current session's log.
    static func exportCurrentSession() -> String {
        (try? String(contentsOf: shared.currentLogURL, encoding: .utf8)) ?? ""
    }

    /// Number of stored session files (including current).
    static func sessionCount() -> Int {
        shared.allLogFiles().count + 1 // rotated + current
    }

    /// Format current in-memory entries as a shareable plain-text string.
    static func exportText() -> String {
        shared.readAllSessions()
    }

    /// Synchronously flush pending writes to disk (used by crash handlers).
    static func flush() {
        shared.writeQueue.sync {}
        shared.fileHandle?.synchronizeFile()
    }

    // MARK: - Internal

    private func append(_ message: String) {
        logger.info("\(message, privacy: .public)")
        let entry = Entry(timestamp: Date(), message: message)
        lock.withLock { state in
            state.append(entry)
            if state.count > Self.maxEntries {
                state.removeFirst(state.count - Self.maxEntries)
            }
        }
        let line = "\(fileDateFormatter.string(from: entry.timestamp))\t\(message)\n"
        writeQueue.async { [weak self] in
            self?.writeToFile(line)
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

        // Only rotate if the current log has content
        let attrs = try? fm.attributesOfItem(atPath: currentLogURL.path)
        let size = attrs?[.size] as? Int ?? 0
        guard size > 0 else { return }

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

        // Sort oldest first (by filename, which embeds the timestamp)
        files.sort()

        // Prune by count: keep only the last N session files
        while files.count > Self.maxSessionFiles {
            try? fm.removeItem(at: logDirectory.appendingPathComponent(files.removeFirst()))
        }

        // Prune by total size: include current.log in the budget
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
    private func allLogFiles() -> [String] {
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
        let device = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "device"
        // Compute locally — can't call Self.sessionCount() during init (reentrancy deadlock)
        let sessions = allLogFiles().count + 1
        let marker = "SESSION-START v\(version)(\(build)) iOS \(os) \(device) sessions=\(sessions)"
        append(marker)
    }

    private func readAllSessions() -> String {
        var parts: [String] = []

        // Read rotated sessions (oldest first)
        for name in allLogFiles() {
            let url = logDirectory.appendingPathComponent(name)
            if let content = try? String(contentsOf: url, encoding: .utf8), !content.isEmpty {
                parts.append(content)
            }
        }

        // Read current session
        // Flush any pending writes first
        writeQueue.sync {}
        if let current = try? String(contentsOf: currentLogURL, encoding: .utf8), !current.isEmpty {
            parts.append(current)
        }

        return parts.joined()
    }
}
