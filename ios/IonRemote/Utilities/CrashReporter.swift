import Foundation

/// Installs signal and uncaught-exception handlers that write crash context
/// to the diagnostic log before the process terminates.
///
/// Call once at app launch (before any UI work).
enum CrashReporter {

    /// Signals we care about — the common crash causes on iOS.
    private static let fatalSignals: [Int32] = [
        SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP
    ]

    /// Install both the ObjC exception handler and POSIX signal handlers.
    static func install() {
        NSSetUncaughtExceptionHandler { exception in
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
}

/// Top-level C-compatible signal handler. Cannot capture context.
private func crashSignalHandler(_ sigNum: Int32) {
    let name: String
    switch sigNum {
    case SIGABRT: name = "SIGABRT"
    case SIGBUS:  name = "SIGBUS"
    case SIGFPE:  name = "SIGFPE"
    case SIGILL:  name = "SIGILL"
    case SIGSEGV: name = "SIGSEGV"
    case SIGTRAP: name = "SIGTRAP"
    default:      name = "SIG\(sigNum)"
    }
    let stack = Thread.callStackSymbols.joined(separator: "\n")
    DiagnosticLog.log("fatal signal", tag: "crash.signal", level: .error, fields: [
        "reason": name,
        "count": String(sigNum),
        "status": stack
    ])
    DiagnosticLog.flush()
    // Re-raise so the default handler runs (generates a crash report).
    signal(sigNum, SIG_DFL)
    raise(sigNum)
}
