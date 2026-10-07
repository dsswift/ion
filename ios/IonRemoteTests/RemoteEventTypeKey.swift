import Foundation
@testable import IonRemote

// MARK: - Test support: an event's wire type

extension RemoteEvent {
    /// The wire type string of this event (`desktop_snapshot`, ...), read back
    /// from its own encoding. Test support only: the app never names an event
    /// by re-encoding it.
    var typeKey: String {
        do {
            let data = try JSONEncoder().encode(self)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return json?["type"] as? String ?? "<unknown>"
        } catch {
            return "<unknown>"
        }
    }
}
