import Foundation

/// Installs signal and uncaught-exception handlers that leave a crash
/// breadcrumb the *next* launch forwards into the diagnostic log.
///
/// Async-signal-safety: a POSIX signal handler may only call async-signal-safe
/// functions (write(2), _exit(2), signal(2), raise(2)…). The previous
/// implementation called `DiagnosticLog.log` / `flush()` from the handler —
/// malloc, Swift string bridging, dispatch, `writeQueue.sync` — none of which
/// is async-signal-safe. A crash inside malloc or while the write queue held a
/// lock deadlocked or corrupted state instead of recording anything, which is
/// why crash artifacts never appeared in the logs.
///
/// The fix: at install time we pre-open a breadcrumb file descriptor with
/// open(2) and pre-format one static byte buffer per signal. The handler does
/// ONLY write(2) of the pre-formatted buffer, then re-raises with the default
/// disposition (unchanged structure). On the next launch,
/// `forwardBreadcrumbIfPresent` reads the breadcrumb file, forwards its
/// content into `DiagnosticLog` at ERROR, and truncates it.
///
/// Call `install()` once at app launch (before any UI work).
enum CrashReporter {

    /// Signals we care about — the common crash causes on iOS.
    private static let fatalSignals: [Int32] = [
        SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP
    ]

    /// Breadcrumb file location (under Caches — survives a crash, is not
    /// backed up, and its loss is acceptable).
    static var breadcrumbURL: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches.appendingPathComponent("crash-breadcrumb.txt")
    }

    /// Install the ObjC exception handler and POSIX signal handlers, after
    /// pre-opening the breadcrumb fd and pre-formatting per-signal buffers.
    static func install() {
        // Forward any breadcrumb left by a previous crashed launch FIRST, so
        // the truncate below cannot race the pre-open of the fd.
        forwardBreadcrumbIfPresent(at: breadcrumbURL.path)

        // Pre-open the breadcrumb fd (O_CREAT|O_APPEND) at install time. The
        // handler never calls open(2) — only write(2) on this fd.
        CrashBreadcrumb.prepare(path: breadcrumbURL.path, signals: fatalSignals)

        NSSetUncaughtExceptionHandler { exception in
            // NSUncaughtExceptionHandler runs in a normal (non-signal) context
            // during unwinding — allocation and dispatch are permitted here,
            // unlike in the POSIX signal handlers below.
            let name = exception.name.rawValue
            let reason = exception.reason ?? "(no reason)"
            let stack = exception.callStackSymbols.joined(separator: "\n")
            DiagnosticLog.log("uncaught exception", tag: "crash.exception", level: .error, fields: [
                "reason": name,
                "error": reason,
                "status": stack
            ])
            DiagnosticLog.flush()
        }

        for sig in fatalSignals {
            signal(sig, crashSignalHandler)
        }
    }

    /// Forward a crash breadcrumb file's content (if any) into DiagnosticLog
    /// at ERROR, then truncate the file. Called on launch. Takes the path as a
    /// parameter so tests can exercise it against a fixture file.
    ///
    /// Returns true when a non-empty breadcrumb was found and forwarded.
    @discardableResult
    static func forwardBreadcrumbIfPresent(at path: String) -> Bool {
        guard let data = FileManager.default.contents(atPath: path), !data.isEmpty else {
            return false
        }
        let content = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else {
            try? Data().write(to: URL(fileURLWithPath: path))
            return false
        }
        DiagnosticLog.log("crash breadcrumb from previous launch", tag: "crash", level: .error, fields: [
            "reason": content
        ])
        // Truncate so the breadcrumb forwards exactly once.
        try? Data().write(to: URL(fileURLWithPath: path))
        return true
    }
}

/// Raw-syscall state for the signal handler. Everything here is prepared at
/// install time; the handler reads only plain memory and calls write(2).
enum CrashBreadcrumb {

    /// One pre-formatted breadcrumb per signal: raw bytes + length.
    struct Slot {
        var ptr: UnsafeMutablePointer<UInt8>?
        var len: Int
    }

    /// Pre-opened breadcrumb fd. -1 until `prepare` runs.
    /// nonisolated(unsafe): written once at install (before handlers are
    /// registered), read from the signal handler. No further mutation.
    nonisolated(unsafe) static var fd: Int32 = -1

    /// Fixed table of 32 slots indexed by signal number (all iOS fatal
    /// signals are < 32). Allocated and filled at install time with
    /// manually-managed raw memory so the handler performs pure pointer
    /// arithmetic — no Dictionary hashing, no Array CoW, no refcounting,
    /// no allocation. nonisolated(unsafe): written once before handlers
    /// are registered, read-only afterwards.
    nonisolated(unsafe) static var slots: UnsafeMutablePointer<Slot>?
    static let slotCount = 32

    /// Open the fd and pre-format one buffer per fatal signal.
    static func prepare(path: String, signals: [Int32]) {
        fd = path.withCString { open($0, O_WRONLY | O_CREAT | O_APPEND, 0o644) }
        let table = UnsafeMutablePointer<Slot>.allocate(capacity: slotCount)
        table.initialize(repeating: Slot(ptr: nil, len: 0), count: slotCount)
        for sig in signals where sig >= 0 && sig < Int32(slotCount) {
            let bytes = Array("fatal signal \(signalName(sig)) (\(sig))\n".utf8)
            let mem = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
            mem.update(from: bytes, count: bytes.count)
            table[Int(sig)] = Slot(ptr: mem, len: bytes.count)
        }
        slots = table
    }

    static func signalName(_ sig: Int32) -> String {
        switch sig {
        case SIGABRT: return "SIGABRT"
        case SIGBUS:  return "SIGBUS"
        case SIGFPE:  return "SIGFPE"
        case SIGILL:  return "SIGILL"
        case SIGSEGV: return "SIGSEGV"
        case SIGTRAP: return "SIGTRAP"
        default:      return "SIG\(sig)"
        }
    }
}

/// Top-level C-compatible signal handler. Async-signal-safe by construction:
/// reads pre-formatted bytes prepared at install time and calls ONLY write(2),
/// then re-raises with the default disposition (so the OS still generates a
/// crash report), exactly as before. No allocation, no dispatch, no os_log,
/// no Swift string bridging.
private func crashSignalHandler(_ sigNum: Int32) {
    if CrashBreadcrumb.fd >= 0,
       let table = CrashBreadcrumb.slots,
       sigNum >= 0, sigNum < Int32(CrashBreadcrumb.slotCount) {
        let slot = table[Int(sigNum)]
        if let ptr = slot.ptr, slot.len > 0 {
            _ = write(CrashBreadcrumb.fd, ptr, slot.len)
        }
    }
    // Re-raise so the default handler runs (generates a crash report).
    signal(sigNum, SIG_DFL)
    raise(sigNum)
}
