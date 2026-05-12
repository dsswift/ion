import Foundation

/// Cached tab/group layout for a paired desktop, persisted to disk.
/// Restored on app launch or device switch so the user sees the last-known
/// layout immediately while the real snapshot loads from the desktop.
struct CachedLayout: Codable {
    let deviceId: String
    let tabs: [RemoteTabState]
    let tabGroupMode: String
    let tabGroups: [RemoteTabGroup]
    let recentDirectories: [String]
    let cachedAt: Date
}

/// Disk-backed layout cache keyed by paired device ID.
enum LayoutCache {

    private static var cacheDirectory: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("layout-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func fileURL(for deviceId: String) -> URL {
        cacheDirectory.appendingPathComponent("\(deviceId).json")
    }

    /// Save the current layout for a device.
    static func save(
        deviceId: String,
        tabs: [RemoteTabState],
        tabGroupMode: String,
        tabGroups: [RemoteTabGroup],
        recentDirectories: [String]
    ) {
        let layout = CachedLayout(
            deviceId: deviceId,
            tabs: tabs,
            tabGroupMode: tabGroupMode,
            tabGroups: tabGroups,
            recentDirectories: recentDirectories,
            cachedAt: Date()
        )
        do {
            let data = try JSONEncoder().encode(layout)
            try data.write(to: fileURL(for: deviceId), options: .atomic)
        } catch {
            print("[Ion] LayoutCache.save failed: \(error)")
        }
    }

    /// Load the cached layout for a device. Returns nil if no cache exists.
    static func load(deviceId: String) -> CachedLayout? {
        let url = fileURL(for: deviceId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CachedLayout.self, from: data)
    }

    /// Delete the cached layout for a device.
    static func delete(deviceId: String) {
        try? FileManager.default.removeItem(at: fileURL(for: deviceId))
    }

    /// Delete all cached layouts.
    static func deleteAll() {
        try? FileManager.default.removeItem(at: cacheDirectory)
    }
}
