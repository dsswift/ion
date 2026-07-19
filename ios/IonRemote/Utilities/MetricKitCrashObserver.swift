import Foundation
import MetricKit

/// MetricKit subscriber that forwards crash and hang diagnostics into
/// DiagnosticLog at ERROR level.
///
/// MetricKit is the system-blessed crash channel: it captures crashes the
/// in-process signal-handler breadcrumb cannot (jetsam memory kills, watchdog
/// terminations, crashes inside the handler itself) because the OS collects
/// them out-of-process and delivers `MXDiagnosticPayload` on the next launch.
/// This complements — not replaces — CrashReporter's breadcrumb: the
/// breadcrumb is immediate and works on simulators; MetricKit is richer
/// (termination reason, exception codes, full call trees) but device-only and
/// delayed to the next launch.
///
/// Deployment target is iOS 17, so MXMetricManager / MXDiagnosticPayload
/// (iOS 13/14+) are unconditionally available — no #available gate needed.
///
/// Wire-up: `MetricKitCrashObserver.start()` at app startup, next to
/// `CrashReporter.install()`.
final class MetricKitCrashObserver: NSObject, MXMetricManagerSubscriber {

    static let shared = MetricKitCrashObserver()

    /// Cap on the serialized call-stack JSON forwarded per diagnostic. Full
    /// call trees run tens of KB; the log line must stay bounded (see
    /// DiagnosticLog.maxMessageBytes rationale).
    static let callStackJSONCap = 4_096

    /// Register with MXMetricManager. Idempotent per process (the manager
    /// dedupes subscribers, but we guard anyway).
    private var started = false

    static func start() {
        shared.startIfNeeded()
    }

    private func startIfNeeded() {
        guard !started else { return }
        started = true
        MXMetricManager.shared.add(self)
        DiagnosticLog.log("metrickit crash observer registered", tag: "crash.metrickit")
    }

    deinit {
        if started {
            MXMetricManager.shared.remove(self)
        }
    }

    // MARK: - MXMetricManagerSubscriber

    /// Diagnostic payloads arrive on the next launch after a crash/hang
    /// (device-only; the simulator never delivers them).
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                DiagnosticLog.log("crash diagnostic (metrickit)", tag: "crash.metrickit", level: .error,
                                  fields: Self.crashFields(crash))
            }
            for hang in payload.hangDiagnostics ?? [] {
                DiagnosticLog.log("hang diagnostic (metrickit)", tag: "crash.metrickit", level: .error,
                                  fields: Self.hangFields(hang))
            }
        }
    }

    // MARK: - Field extraction (static + testable)

    static func crashFields(_ crash: MXCrashDiagnostic) -> [String: String] {
        var fields: [String: String] = [:]
        if let signal = crash.signal {
            fields["signal"] = signal.stringValue
        }
        if let exceptionType = crash.exceptionType {
            fields["exception_type"] = exceptionType.stringValue
        }
        if let exceptionCode = crash.exceptionCode {
            fields["exception_code"] = exceptionCode.stringValue
        }
        if let reason = crash.terminationReason {
            fields["reason"] = reason
        }
        fields["app_build"] = crash.metaData.applicationBuildVersion
        fields["status"] = cappedCallStackJSON(crash.callStackTree)
        return fields
    }

    static func hangFields(_ hang: MXHangDiagnostic) -> [String: String] {
        var fields: [String: String] = [:]
        fields["duration_ms"] = String(Int(hang.hangDuration.converted(to: .milliseconds).value))
        fields["app_build"] = hang.metaData.applicationBuildVersion
        fields["status"] = cappedCallStackJSON(hang.callStackTree)
        return fields
    }

    /// Serialize a call-stack tree to JSON, capped at `callStackJSONCap` bytes
    /// with a truncation marker. Exposed for tests via `cappedJSON`.
    static func cappedCallStackJSON(_ tree: MXCallStackTree) -> String {
        cappedJSON(tree.jsonRepresentation())
    }

    /// Bound raw JSON data to `callStackJSONCap` UTF-8 bytes on a character
    /// boundary, appending a truncation marker when cut. Pure function —
    /// directly unit-testable without a real MXCallStackTree (MetricKit
    /// diagnostic types cannot be constructed in tests).
    static func cappedJSON(_ data: Data) -> String {
        let full = String(decoding: data, as: UTF8.self)
        guard full.utf8.count > callStackJSONCap else { return full }
        var out = String(full.prefix(callStackJSONCap))
        while out.utf8.count > callStackJSONCap {
            out = String(out.prefix(out.count - out.utf8.count + callStackJSONCap))
        }
        return out + "…[truncated]"
    }
}
