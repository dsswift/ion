import Foundation

/// An engine profile synced from the desktop settings.
/// Each profile configures a set of extensions for an engine tab.
/// defaultMode is optional; absent means auto (the desktop default).
struct EngineProfile: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let extensions: [String]
    let defaultMode: String?
}
