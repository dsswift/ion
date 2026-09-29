import Foundation

/// Where new clones land on one server. The desktop keeps this per device;
/// the phone keeps it per server in its own defaults.
enum CloneBaseDirectory {
    static let defaultValue = "~/source"

    static func key(serverId: String) -> String { "cloneBaseDirectory.\(serverId)" }

    static func read(serverId: String, defaults: UserDefaults = .standard) -> String {
        let stored = defaults.string(forKey: key(serverId: serverId))?.trimmingCharacters(in: .whitespaces) ?? ""
        return stored.isEmpty ? defaultValue : stored
    }

    /// Saves `value` without a trailing slash; a blank value restores the default.
    static func write(_ value: String, serverId: String, defaults: UserDefaults = .standard) {
        let trimmed = normalized(value)
        if trimmed.isEmpty {
            defaults.removeObject(forKey: key(serverId: serverId))
        } else {
            defaults.set(trimmed, forKey: key(serverId: serverId))
        }
        DiagnosticLog.log("projects: clone base folder saved", tag: "admin.projects", fields: [
            "server_id": serverId, "reset": String(trimmed.isEmpty)
        ])
    }

    static func normalized(_ value: String) -> String {
        var trimmed = value.trimmingCharacters(in: .whitespaces)
        while trimmed.count > 1 && trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed
    }
}
