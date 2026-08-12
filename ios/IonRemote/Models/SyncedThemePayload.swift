import Foundation

// MARK: - SyncedThemePayload

/// One custom theme's iOS component as carried by `desktop_theme_manifest`.
///
/// The desktop ships only the iOS side of an installed theme pack: the full
/// AppTheme token set as `#RRGGBBAA` hex strings, an optional forced color
/// scheme, and descriptors for any image assets (fetched lazily via
/// `desktop_request_theme_asset` when the sha256 misses the local cache).
/// Payloads persist per paired desktop in `SyncedThemeStore` so synced
/// themes keep working offline.
struct SyncedThemePayload: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let version: String
    /// AppTheme token key → #RRGGBBAA (or #RRGGBB / #RGB) hex string.
    let tokens: [String: String]
    /// Built-in theme id whose token values fill every REQUIRED token this
    /// payload omits (`required-when-partial`). nil = the payload supplies the
    /// complete required set and inherits nothing. Resolved against the
    /// compiled-in built-in themes by `SyncedTheme`; an unknown id falls back
    /// to Ion Dark there, same as any other unresolvable theme id.
    let base: String?
    /// "light" | "dark"; nil = follow the system setting.
    let preferredColorScheme: String?
    let assets: [SyncedThemeAssetDescriptor]?
}

/// Descriptor for one pack image asset. The bytes are NOT inline — iOS
/// requests them by (themeId, slot) and caches them keyed by sha256.
struct SyncedThemeAssetDescriptor: Codable, Equatable, Sendable {
    /// "background" (full-screen backdrop) or "logo" (Settings brand mark).
    let slot: String
    let sha256: String
    let size: Int
}
