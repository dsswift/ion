import Foundation

/// The `excludedResourceKinds` Personal preference: which resource kinds stay
/// out of the notification inbox. A blocklist, so a kind the phone has never
/// seen shows by default.
enum NotificationKinds {

    static let key = "excludedResourceKinds"
    /// Kinds the server's Studio clients use to talk to themselves; never a notification.
    private static let studioControlPrefix = "ion-studio."
    /// The operator focus Studio publishes for extensions; never a notification.
    private static let studioFocusKind = "desktop.focus"

    /// The kinds to offer: every workspace kind the phone has seen, plus every
    /// kind already hidden so a quiet one can be turned back on. Sorted.
    static func kinds(seen: [String: [ResourceItem]], excluded: [String]) -> [String] {
        var out = Set<String>()
        for (kind, items) in seen where items.contains(where: { $0.conversationId?.isEmpty ?? true }) {
            out.insert(kind)
        }
        out.formUnion(excluded)
        return out.filter { !isStudioTraffic($0) && !$0.isEmpty }.sorted()
    }

    /// Studio's own resource traffic, which no inbox shows.
    static func isStudioTraffic(_ kind: String) -> Bool {
        kind.hasPrefix(studioControlPrefix) || kind == studioFocusKind
    }

    /// The hidden kinds in `state`, or none when the server does not describe the key.
    static func excluded(in state: ServerSettingsState?) -> [String] {
        guard let list = state?.currentValue(for: key)?.value as? [AnyCodable] else { return [] }
        return list.compactMap { $0.value as? String }
    }

    /// The blocklist after showing or hiding `kind`. Sorted, so the saved value is stable.
    static func excluded(_ current: [String], setting kind: String, shown: Bool) -> [String] {
        var next = Set(current)
        if shown { next.remove(kind) } else { next.insert(kind) }
        return next.sorted()
    }

    /// The value saved for `excluded`.
    static func value(_ excluded: [String]) -> AnyCodable {
        AnyCodable(excluded.map { AnyCodable($0) })
    }
}
