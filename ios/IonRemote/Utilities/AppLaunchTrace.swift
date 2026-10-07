import Foundation
import Darwin

/// The `app.launch` span: the process starting to the first scene being
/// active. It is a root; the launch's first `connection.connect`,
/// `pairing.complete`, and `snapshot.apply` are its children.
final class AppLaunchTrace: @unchecked Sendable {

    static let shared = AppLaunchTrace()

    static let spanName = "app.launch"

    private let lock = NSLock()
    private let span: TraceSpan
    private var parented: Set<String> = []

    init(processStart: Date = AppLaunchTrace.processStartDate(), writer: TraceSpan.Writer? = nil) {
        span = TraceSpan(name: Self.spanName, attributes: ["surface": "ios"], start: processStart, writer: writer)
    }

    /// The first scene is on screen. Ends the span; later calls do nothing.
    @discardableResult
    func sceneActive(at now: Date = Date()) -> TraceSpan.Record? {
        span.end(at: now)
    }

    /// The launch as the parent of the first span of a kind this process
    /// starts. Nil for every later one: a reconnect or a resync is its own
    /// trace, not the launch's.
    func parentForFirst(_ name: String) -> String? {
        lock.withLock {
            guard !parented.contains(name) else { return nil }
            parented.insert(name)
            return span.traceparent
        }
    }

    /// When this process started, from the kernel's record of it; now when
    /// the kernel does not answer, which makes the launch read as instant
    /// rather than as missing.
    static func processStartDate() -> Date {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let status = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard status == 0 else {
            DiagnosticLog.log("process start time unavailable, launch span starts now", tag: "app.launch", level: .warn, fields: [
                "errno": String(errno)
            ])
            return Date()
        }
        let started = info.kp_proc.p_starttime
        return Date(timeIntervalSince1970: TimeInterval(started.tv_sec) + TimeInterval(started.tv_usec) / 1_000_000)
    }
}
