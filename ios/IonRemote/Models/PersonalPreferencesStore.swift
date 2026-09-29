import Foundation

/// The settings this phone keeps itself: Personal preferences and Device
/// settings.
///
/// A Personal preference is yours on every server, so it lives on the client
/// and no server keeps a settings copy (the server's settings registry, scope
/// `personal`). The few a server consumes are declared to it once per
/// connection and on change (`RemoteCommand.declarePreferences`); the server
/// holds them for the life of the connection and stamps them onto the
/// conversations this phone creates or prompts.
///
/// They used to live on each server and be edited remotely through the
/// projected settings list. `adopt` carries those earlier values over once,
/// so nothing a person had chosen is lost in the move.
enum PersonalPreferencesStore {
    /// The preferences a server consumes. Must match the server registry's
    /// travelling keys (`TRAVELLING_PREFERENCE_KEYS`); pinned by
    /// `PersonalPreferencesStoreTests`.
    static let travellingKeys: [String] = [
        "defaultPermissionMode",
        "defaultThinkingEffort",
        "aiGeneratedTitles",
        "enableClaudeCompat",
        "enableEarlyStopContinuation",
    ]

    private static let prefix = "clientSetting."

    static func isPersonal(_ key: String) -> Bool { travellingKeys.contains(key) }

    /// True for a scope whose settings live on this phone: a Personal
    /// preference (yours on every server) or a Device setting (this screen).
    /// The scope arrives on each schema entry from the server's registry.
    static func isClientOwned(scope: String?) -> Bool {
        scope == "personal" || scope == "device"
    }

    /// The locally stored value, or nil when this phone has never held one.
    static func value(for key: String, defaults: UserDefaults = .standard) -> AnyCodable? {
        guard let data = defaults.data(forKey: prefix + key) else { return nil }
        do {
            return try JSONDecoder().decode(AnyCodable.self, from: data)
        } catch {
            DiagnosticLog.log("stored client setting unreadable; ignored", tag: "preferences", level: .warn, fields: ["key": key, "error": String(describing: error)])
            return nil
        }
    }

    static func set(_ key: String, _ value: AnyCodable, defaults: UserDefaults = .standard) {
        do {
            defaults.set(try JSONEncoder().encode(value), forKey: prefix + key)
            DiagnosticLog.log("client setting stored", tag: "preferences", fields: ["key": key])
        } catch {
            DiagnosticLog.log("client setting not stored", tag: "preferences", level: .warn, fields: ["key": key, "error": String(describing: error)])
        }
    }

    /// Take the values a server still holds from before the move, for
    /// client-owned keys this phone has no value for yet. Returns the adopted
    /// keys. `UserDefaults` answers nil for a key never set, so absence here
    /// really does mean "never chosen on this phone".
    @discardableResult
    static func adopt(from serverSettings: [String: AnyCodable], clientOwnedKeys: [String], defaults: UserDefaults = .standard) -> [String] {
        var adopted: [String] = []
        for key in clientOwnedKeys where value(for: key, defaults: defaults) == nil {
            guard let legacy = serverSettings[key] else { continue }
            set(key, legacy, defaults: defaults)
            adopted.append(key)
        }
        if !adopted.isEmpty {
            DiagnosticLog.log("adopted earlier server-held settings onto this phone", tag: "preferences", fields: ["keys": adopted.joined(separator: ",")])
        }
        return adopted
    }

    /// What this phone declares to a server: the travelling keys it holds.
    static func declared(defaults: UserDefaults = .standard) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for key in travellingKeys {
            guard let stored = value(for: key, defaults: defaults)?.value else { continue }
            if let bool = stored as? Bool { out[key] = .bool(bool) }
            else if let string = stored as? String { out[key] = .string(string) }
        }
        return out
    }

    /// The projected settings with this phone's own values laid over every
    /// client-owned key, so the list shows what this phone actually uses.
    static func overlay(_ serverSettings: [String: AnyCodable], clientOwnedKeys: [String], defaults: UserDefaults = .standard) -> [String: AnyCodable] {
        var out = serverSettings
        for key in clientOwnedKeys {
            if let local = value(for: key, defaults: defaults) { out[key] = local }
        }
        return out
    }
}
