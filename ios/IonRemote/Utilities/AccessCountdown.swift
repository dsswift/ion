import Foundation

/// Time left until an expiry, as a person reads it off a pairing screen.
enum AccessCountdown {
    /// `m:ss` until `until`, never negative.
    static func remaining(until: Date, now: Date) -> String {
        let seconds = max(0, Int((until.timeIntervalSince(now)).rounded()))
        return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }
}
