import Foundation
import Security

/// Stable per-installation identity persisted in the Keychain.
///
/// Survives app updates but not a full uninstall+reinstall (Keychain item is
/// scoped to the app via `kSecAttrService`). Used as `mobileDeviceId` in
/// pairing and recovery requests so the desktop can correlate a phone across
/// re-pairs without relying on the mutable `UIDevice.current.name`.
enum MobileInstallationIdentity {

    private static let service = "com.ion.mobile-installation-id"

    /// Returns the stable installation UUID, creating and persisting one on
    /// first call. Thread-safe: concurrent callers may race to create, but
    /// the Keychain dedup (delete-then-add) and the deterministic read-back
    /// ensure every caller gets the same value.
    static func id() -> String {
        if let existing = KeychainHelper.get(service) {
            return existing
        }
        let fresh = UUID().uuidString
        KeychainHelper.set(fresh, service: service)
        return KeychainHelper.get(service) ?? fresh
    }
}
