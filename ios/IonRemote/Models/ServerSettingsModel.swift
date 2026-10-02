import Foundation

// Server settings projection model.
//
// Mirror of the server's `projectable-settings.ts` schema/values shape,
// surfaced as Swift types the SwiftUI Settings view can render directly.
//
// Per-server scoping
// ───────────────────
// `SessionViewModel.serverSettings` holds the connected server's projection;
// a server's settings pages read that server's through its `ServerAdminSession`.

/// Wire shape for the enterprise new-conversation policy projected via
/// `desktop_settings_snapshot.newConversationPolicy`. Mirrors `NewConversationDefaultsPolicy`
/// in `packages/shared/src/types-session.ts`.
///
/// When non-nil AND `locked=true`, the iOS new-conversation flow must skip
/// both directory picker and profile picker and open directly with
/// `baseDirectory` and `engineProfileId` (empty string = plain conversation).
struct RemoteNewConversationPolicy: Codable, Equatable, Sendable {
    /// Mandated working directory. Empty string = no constraint.
    let baseDirectory: String
    /// Mandated engine profile id. Empty string = plain conversation.
    let engineProfileId: String
    /// When true, the user cannot override these values on iOS.
    let locked: Bool
}

/// Wire shape for the enterprise theme policy projected via
/// `desktop_settings_snapshot.themePolicy` (mirrors the server's
/// `customFields['ion-desktop'].themePolicy`). `themeId` resolves against
/// built-ins + synced theme packs; `locked=true` forces the theme and
/// disables the iOS theme picker, `locked=false` is a managed default the
/// user may override. Nil = unmanaged.
struct RemoteThemePolicy: Codable, Equatable, Sendable {
    let themeId: String
    let locked: Bool
}
// SessionViewModel keeps a single `serverSettings: ServerSettingsState?`
// optional; every `desktopSettingsSnapshot` event REPLACES that field in
// full (snapshot semantics — never merge). Switching transports clears
// the field so the next server's snapshot can populate it fresh.
//
// Schema-on-the-wire (Apple-Settings-style UX)
// ────────────────────────────────────────────
// The server emits both values and metadata (label, description, group,
// choices, range, itemSchema) in every snapshot. iOS auto-renders the
// Settings detail view from this metadata — there is no hardcoded
// per-key Swift code. Adding a new projectable setting on the server
// is a one-line allowlist entry; iOS picks it up on the next snapshot.
// The view falls back to a generic "Other" section when it sees an
// unknown `group` identifier and a read-only string row when it sees an
// unknown `type` value, so future server changes never crash older iOS
// builds.
//
// Type system
// ───────────
// Five wire types: `boolean`, `string`, `number`, `enum`, `list`.
//   - `boolean` → Toggle.
//   - `string` → TextField.
//   - `number` → Stepper (clamped by the optional `range` field).
//   - `enum` → Picker with `choices`. `value` may be `null` for nullable
//             enums (the "None" choice).
//   - `list` → NavigationLink to a per-record editor screen
//             (ServerSettingsListEditor). The list's `itemSchema`
//             declares the per-record fields; the editor reuses the
//             same row renderers recursively.
//
// The structs in this file are deliberately small and Codable-friendly
// so JSONDecoder can populate them directly off the wire payload.

/// Allowed value types for a projected setting. Mirrors the server's
/// `ProjectableType`. The view layer switches on this to decide which
/// SwiftUI control to render.
///
/// Adding a new case here is wire-compatible with older builds because
/// the server's `desktop_settings_snapshot` event already tolerates
/// unknown types in its forward-compat fallback (read-only string row).
enum ServerSettingType: String, Codable, Sendable {
    case boolean
    case string
    case number
    case enumType = "enum"
    case list
}

/// One choice in an enum-typed projectable setting. Mirrors the server's
/// `ProjectableChoice`. `value` is the JSON value written back over the
/// wire when this choice is selected; `label` is the user-facing string.
///
/// `value` is `AnyCodable` (not optional) so the wire's `null` round-
/// trips end-to-end as `AnyCodable(NSNull())`. This matters because
/// SwiftUI Pickers can't use optional tags directly — we route through
/// `selectionKey` below to translate between the wire value and a
/// string-typed Picker selection.
struct ServerSettingChoice: Codable, Sendable, Identifiable, Hashable {
    /// Stable identifier for SwiftUI ForEach. Derived from `label` —
    /// labels are unique within a single enum's choice set (the
    /// server guarantees this by construction).
    var id: String { label }

    let value: AnyCodable
    let label: String

    /// String form of `value` for use as a SwiftUI Picker selection
    /// tag. JSON null (`NSNull()` under AnyCodable) becomes the empty
    /// string; this is reversed back to `null` when writing the value
    /// over the wire. Apple's Picker doesn't accept optional values as
    /// tags, so we route through this intermediate string representation.
    var selectionKey: String {
        if value.value is NSNull { return "" }
        if let s = value.value as? String { return s }
        return String(describing: value.value)
    }

    static func == (lhs: ServerSettingChoice, rhs: ServerSettingChoice) -> Bool {
        // Equality is structural over the wire value + label. AnyCodable
        // doesn't conform to Equatable so we compare the underlying
        // representations via `selectionKey`.
        return lhs.label == rhs.label && lhs.selectionKey == rhs.selectionKey
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(label)
        hasher.combine(selectionKey)
    }
}

/// Optional numeric bounds carried by `number`-typed entries. Used by
/// the Stepper renderer to clamp +/- and pick a sensible step. Absent
/// → the view falls back to a permissive `0...10000` step-1 default.
struct ServerSettingRange: Codable, Sendable {
    let min: Double
    let max: Double
    let step: Double
}

/// One entry in the projection schema. Carries everything iOS needs to
/// render a row: the wire key, the value type, the visual group, the
/// row label, the descriptive footer, the default value to fall back on,
/// and per-type extensions (`choices` for enum, `range` for number,
/// `itemSchema` for record-list, `itemType` for primitive-list).
///
/// List shape disambiguation
/// ─────────────────────────
/// A `list`-typed entry carries exactly one of:
///   - `itemSchema`: record-list. iOS pushes a per-record editor view
///     and renders rows as NavigationLinks (`ServerSettingsListEditor`).
///   - `itemType`: primitive-list. iOS renders a flat list of inline
///     editors (`ServerSettingsPrimitiveListEditor`) — TextField per
///     row for `.string`, Stepper for `.number`, Toggle for `.boolean`.
///
/// Older server builds that don't know about `itemType` send neither;
/// iOS falls through to a read-only fallback (forward-compat).
struct ServerSettingSchemaEntry: Codable, Sendable, Identifiable {
    /// Unique id for SwiftUI `ForEach` purposes — derived from `key`.
    var id: String { key }

    let key: String
    let type: ServerSettingType
    /// Group identifier. Matches the `id` of one of the entries in
    /// `groups` on the snapshot. Unknown groups (forward-compat)
    /// render under a fallback section in the view.
    let group: String
    let label: String
    let description: String
    /// Default value the server uses when settings.json omits the
    /// key. AnyCodable holds the underlying Bool/String/Double/null/
    /// array; the view reads it as a typed fallback when `settings[key]`
    /// is nil.
    let defaultValue: AnyCodable
    /// For `enum`-typed entries: the available choices in render order.
    /// Includes the "None" choice for nullable enums.
    let choices: [ServerSettingChoice]?
    /// For `number`-typed entries: optional bounds.
    let range: ServerSettingRange?
    /// For record-list `list`-typed entries: per-field metadata for one
    /// record. Reuses the same `ServerSettingSchemaEntry` recursively so
    /// the editor renders nested rows with the same row renderers.
    let itemSchema: [ServerSettingSchemaEntry]?
    /// For primitive-list `list`-typed entries: the scalar type of each
    /// element. Mutually exclusive with `itemSchema`. When set, the
    /// view dispatches to `ServerSettingsPrimitiveListEditor` instead
    /// of the record-list editor.
    let itemType: ServerSettingType?
    /// The key's scope in the server's settings registry (`environment`,
    /// `account`, `personal`, `device`). Absent on a nested `itemSchema`
    /// field. See `ServerSettingsState.isReadOnly`.
    var scope: String? = nil
    /// The organization sealed this key to the value shown; nobody may change
    /// it from any client. Absent on older servers and on nested fields.
    var sealed: Bool? = nil
    /// The settings page this key renders on (`ServerSettingsPage.id`).
    /// Absent on older servers and on nested fields.
    var page: String? = nil
    /// The section of that page (`ServerSettingsPage.Section.id`).
    var section: String? = nil
}

/// Section descriptor. Pairs a stable group identifier with its
/// display label. The view renders one Section per descriptor in the
/// order they appear in the `groups` array.
struct ServerSettingGroupDescriptor: Codable, Sendable, Identifiable {
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
/// server's projected settings. Replaced wholesale on every snapshot.
///
/// The view derives section-bucketed rows from the schema's `group`
/// field, falling back to an "Other" bucket for unknown groups. The
/// current value of each setting is looked up by key in `settings`,
/// with a fall-through to `defaultValue` from the schema entry.
struct ServerSettingsState: Sendable {
    /// Map of key → current value. Snapshot semantics — every key in
    /// the schema must be present, but the view defensively falls back
    /// to schema `defaultValue` if a key is missing.
    let settings: [String: AnyCodable]
    /// Per-key metadata in the order the server emitted it (which is
    /// the order the view should render rows within a group).
    let schema: [ServerSettingSchemaEntry]
    /// Group descriptors in the order the view should render sections.
    let groups: [ServerSettingGroupDescriptor]
    /// Whether this phone's connection holds `admin` on the server. An
    /// Environment setting is one value for the whole server, so only an
    /// admin connection may change it; everyone else can still read it.
    let canManageEnvironment: Bool
    /// The settings pages in render order. Empty from a server that predates them.
    let pages: [ServerSettingsPage]

    init(
        settings: [String: AnyCodable],
        schema: [ServerSettingSchemaEntry],
        groups: [ServerSettingGroupDescriptor],
        canManageEnvironment: Bool = false,
        pages: [ServerSettingsPage] = []
    ) {
        self.settings = settings
        self.schema = schema
        self.groups = groups
        self.canManageEnvironment = canManageEnvironment
        self.pages = pages
    }

    /// Entries of one page section, in schema order.
    func entries(page pageId: String, section sectionId: String) -> [ServerSettingSchemaEntry] {
        schema.filter { $0.page == pageId && $0.section == sectionId }
    }

    /// Keys of the entries this phone keeps itself (Personal and Device).
    var clientOwnedKeys: [String] {
        schema.filter { PersonalPreferencesStore.isClientOwned(scope: $0.scope) }.map(\.key)
    }

    /// Every entry this phone keeps itself, in schema order.
    func clientOwnedEntries() -> [ServerSettingSchemaEntry] {
        schema.filter { PersonalPreferencesStore.isClientOwned(scope: $0.scope) }
    }

    /// True when `entry` is shown but may not be changed from this phone: the
    /// organization sealed it, or it is an Environment setting and this
    /// connection lacks `admin`. The server refuses the write either way;
    /// this keeps the phone from offering an edit that would bounce.
    func isReadOnly(_ entry: ServerSettingSchemaEntry) -> Bool {
        if entry.sealed == true { return true }
        return entry.scope == "environment" && !canManageEnvironment
    }

    /// Lookup helper used by the view layer. Returns the current value
    /// if present, otherwise the schema's declared default. Returns
    /// `nil` only when `key` is not in the schema at all (i.e. the
    /// caller asked for an unknown key — a programming error).
    func currentValue(for key: String) -> AnyCodable? {
        if let v = settings[key] {
            return v
        }
        // Fall back to schema default for keys the snapshot omitted
        // (defensive — the server is supposed to send every key).
        if let entry = schema.first(where: { $0.key == key }) {
            return entry.defaultValue
        }
        return nil
    }

    /// Returns the schema entries that belong to a given group, in the
    /// order they appear in `schema`.
    func entries(in groupId: String) -> [ServerSettingSchemaEntry] {
        schema.filter { $0.group == groupId }
    }
}
