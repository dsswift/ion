import Foundation

// MARK: - RemoteCommand bounded case-name accessor

extension RemoteCommand {

    /// The bare enum case name (e.g. "prompt", "diagnosticLogsResponse"),
    /// with NO associated-value payload.
    ///
    /// This exists because `String(describing:)` / `"\(command)"` on an enum
    /// with associated values interpolates the ENTIRE payload — for a
    /// `.diagnosticLogsResponse` carrying megabytes of log lines that produced
    /// a multi-megabyte string (observed: 2,065,388 chars) which was then used
    /// as an essential-queue key and re-interpolated into every queue log
    /// line, amplifying memory until jetsam killed the app.
    ///
    /// `Mirror(reflecting:)` on an enum case with a payload exposes exactly one
    /// child whose `label` is the case name and whose `value` is the payload
    /// tuple — reading the label never stringifies the payload. Payload-less
    /// cases have no children; for those `String(describing: self)` is already
    /// bounded (it is just the case name) and is the correct fallback.
    ///
    /// Always O(case-name length), never O(payload size).
    var kindName: String {
        if let label = Mirror(reflecting: self).children.first?.label {
            return label
        }
        return String(describing: self)
    }
}
