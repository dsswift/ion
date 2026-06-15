import Foundation

/// Manual tab group definition synced from the desktop. Used by the
/// `snapshot` RemoteEvent (the `tabGroups` payload). Extracted from
/// NormalizedEvent.swift to keep that file under the 600-line cap — one
/// type per file is the iOS idiom.
struct RemoteTabGroup: Codable, Identifiable, Sendable {
    let id: String
    let label: String
    let isDefault: Bool
    var order: Int
}
