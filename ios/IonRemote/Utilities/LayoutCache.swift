import Foundation

/// Cached tab layout for a paired desktop, persisted to disk.
/// Restored on app launch or device switch so the user sees the last-known
/// layout immediately while the real snapshot loads from the desktop.
struct CachedLayout: Codable {
    let deviceId: String
    let tabs: [RemoteTabState]
    let recentDirectories: [String]
    let cachedAt: Date
}

/// Disk-backed layout cache keyed by paired device ID.
enum LayoutCache {

    private static var cacheDirectory: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("layout-cache", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            DiagnosticLog.log("layout cache directory create failed", tag: "cache.layout", level: .error, fields: [
                "error": error.localizedDescription
            ])
        }
        return dir
    }

    private static func fileURL(for deviceId: String) -> URL {
        cacheDirectory.appendingPathComponent("\(deviceId).json")
    }

    /// Save the current layout for a device.
    static func save(
        deviceId: String,
        tabs: [RemoteTabState],
        recentDirectories: [String]
    ) {
        let layout = CachedLayout(
            deviceId: deviceId,
            tabs: tabs,
            recentDirectories: recentDirectories,
            cachedAt: Date()
        )
        do {
            let data = try JSONEncoder().encode(layout)
            try data.write(to: fileURL(for: deviceId), options: .atomic)
            DiagnosticLog.log("layout cache save ok", tag: "cache.layout", fields: [
                "device": String(deviceId.prefix(8)),
                "count": String(tabs.count)
            ])
        } catch {
            DiagnosticLog.log("layout cache save failed", tag: "cache.layout", level: .error, fields: [
                "device": String(deviceId.prefix(8)),
                "error": error.localizedDescription
            ])
        }
    }

    /// Load the cached layout for a device. Returns nil if no cache exists.
    static func load(deviceId: String) -> CachedLayout? {
        let url = fileURL(for: deviceId)
        // No cache file is the normal first-launch case; nil means wait for the live layout.
        // swiftlint:disable:next silent_try_optional
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try JSONDecoder().decode(CachedLayout.self, from: data)
        } catch {
            DiagnosticLog.log("layout cache decode failed", tag: "cache.layout", level: .warn, fields: [
                "device": String(deviceId.prefix(8)),
                "error": error.localizedDescription
            ])
            return nil
        }
    }

    /// Delete the cached layout for a device.
    static func delete(deviceId: String) {
        do {
            try FileManager.default.removeItem(at: fileURL(for: deviceId))
        } catch CocoaError.fileNoSuchFile {
            // No cache was ever written for this device; nothing to delete.
        } catch {
            DiagnosticLog.log("layout cache delete failed", tag: "cache.layout", level: .warn, fields: [
                "device": String(deviceId.prefix(8)),
                "error": error.localizedDescription
            ])
        }
    }

    /// Delete all cached layouts.
    static func deleteAll() {
        do {
            try FileManager.default.removeItem(at: cacheDirectory)
        } catch CocoaError.fileNoSuchFile {
            // The cache directory does not exist; nothing to delete.
        } catch {
            DiagnosticLog.log("layout cache delete-all failed", tag: "cache.layout", level: .warn, fields: [
                "error": error.localizedDescription
            ])
        }
    }
}
