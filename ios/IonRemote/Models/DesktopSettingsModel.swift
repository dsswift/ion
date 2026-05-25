import Foundation

// Desktop-settings projection model.
//
// Mirror of the desktop's `projectable-settings.ts` schema/values shape,
// surfaced as Swift types the SwiftUI Settings view can render directly.
//
// Per-desktop scoping
// ───────────────────
// iOS shows projected settings for the currently-connected desktop only.
// SessionViewModel keeps a single `desktopSettings: DesktopSettingsState?`
// optional; every `desktopSettingsSnapshot` event REPLACES that field in
// full (snapshot semantics — never merge). Switching transports clears
// the field so the next desktop's snapshot can populate it fresh.
//
// Schema-on-the-wire (Apple-Settings-style UX)
// ────────────────────────────────────────────
// The desktop emits both values and metadata (label, description, group)
// in every snapshot. iOS auto-renders the Settings detail view from this
// metadata — there is no hardcoded per-key Swift code. Adding a new
// projectable setting on the desktop is a one-line allowlist entry; iOS
// picks it up on the next snapshot. The view falls back to a generic
// "Other" section when it sees an unknown `group` identifier so future
// desktop changes never crash older iOS builds.
//
// The structs in this file are deliberately small and Codable-friendly
// so JSONDecoder can populate them directly off the wire payload.

/// Allowed value types for a projected setting. Mirrors the desktop's
/// `ProjectableType`. The view layer switches on this to decide which
/// SwiftUI control to render (Toggle for boolean, TextField for string,
/// Stepper for number).
enum DesktopSettingType: String, Codable, Sendable {
    case boolean
    case string
    case number
}

/// One entry in the projection schema. Carries everything iOS needs to
/// render a row: the wire key, the value type, the visual group, the
/// row label, the descriptive footer, and the default value to fall
/// back on when `settings` omits the key.
struct DesktopSettingSchemaEntry: Codable, Sendable, Identifiable {
    /// Unique id for SwiftUI `ForEach` purposes — derived from `key`.
    var id: String { key }

    let key: String
    let type: DesktopSettingType
    /// Group identifier. Matches the `id` of one of the entries in
    /// `groups` on the snapshot. Unknown groups (forward-compat)
    /// render under a fallback section in the view.
    let group: String
    let label: String
    let description: String
    /// Default value the desktop uses when settings.json omits the
    /// key. AnyCodable holds the underlying Bool/String/Double; the
    /// view reads it as a typed fallback when `settings[key]` is nil.
    let defaultValue: AnyCodable
}

/// Section descriptor. Pairs a stable group identifier with its
/// display label. The view renders one Section per descriptor in the
/// order they appear in the `groups` array.
struct DesktopSettingGroupDescriptor: Codable, Sendable, Identifiable {
    var id: String { groupId }

    /// On the wire this field is named `id`. Renamed to `groupId` on
    /// the Swift side to avoid clashing with the Identifiable
    /// protocol's `id` requirement, which uses a computed property
    /// pointing back at this field.
    let groupId: String
    let label: String

    private enum CodingKeys: String, CodingKey {
        case groupId = "id"
        case label
    }
}

/// Aggregate state held by SessionViewModel for the currently-connected
/// desktop's projected settings. Replaced wholesale on every snapshot.
///
/// The view derives section-bucketed rows from the schema's `group`
/// field, falling back to an "Other" bucket for unknown groups. The
/// current value of each setting is looked up by key in `settings`,
/// with a fall-through to `defaultValue` from the schema entry.
struct DesktopSettingsState: Sendable {
    /// Map of key → current value. Snapshot semantics — every key in
    /// the schema must be present, but the view defensively falls back
    /// to schema `defaultValue` if a key is missing.
    let settings: [String: AnyCodable]
    /// Per-key metadata in the order the desktop emitted it (which is
    /// the order the view should render rows within a group).
    let schema: [DesktopSettingSchemaEntry]
    /// Group descriptors in the order the view should render sections.
    let groups: [DesktopSettingGroupDescriptor]

    /// Lookup helper used by the view layer. Returns the current value
    /// if present, otherwise the schema's declared default. Returns
    /// `nil` only when `key` is not in the schema at all (i.e. the
    /// caller asked for an unknown key — a programming error).
    func currentValue(for key: String) -> AnyCodable? {
        if let v = settings[key] {
            return v
        }
        // Fall back to schema default for keys the snapshot omitted
        // (defensive — the desktop is supposed to send every key).
        if let entry = schema.first(where: { $0.key == key }) {
            return entry.defaultValue
        }
        return nil
    }

    /// Returns the schema entries that belong to a given group, in the
    /// order they appear in `schema`. Used by the view to drive the
    /// per-section ForEach.
    func entries(in groupId: String) -> [DesktopSettingSchemaEntry] {
        schema.filter { $0.group == groupId }
    }

    /// Returns schema entries whose `group` does not match any
    /// descriptor in `groups`. The view renders these under a
    /// fallback "Other" section so a forward-compat group identifier
    /// from a newer desktop still produces a usable UI.
    func orphanedEntries() -> [DesktopSettingSchemaEntry] {
        let knownGroups = Set(groups.map(\.groupId))
        return schema.filter { !knownGroups.contains($0.group) }
    }
}
