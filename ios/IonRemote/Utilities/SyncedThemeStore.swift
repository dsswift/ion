import Foundation

// MARK: - SyncedThemeStore

/// Disk persistence for custom themes synced from paired desktops.
///
/// Payloads persist to Documents/`synced-themes.json` keyed **per desktop
/// device id** — a `desktop_theme_manifest` from desktop A replaces only
/// A's theme set, so syncing with one desktop never prunes another's
/// themes. Image assets persist as individual files named
/// `<themeId>.<slot>.<sha256>` under Documents/`synced-theme-assets/
/// <desktopId>/`; embedding the sha in the filename makes cache validity a
/// file-existence check and stale-hash cleanup a prefix prune.
///
/// Everything here is best-effort durable: a corrupt store file resets to
/// empty (logged), never crashes. Themes therefore survive offline
/// relaunches — ThemeManager seeds its custom registry from this store at
/// app start, before any desktop connection exists.
final class SyncedThemeStore: @unchecked Sendable {
    static let shared = SyncedThemeStore()

    private struct StoreFile: Codable {
        var byDesktop: [String: [SyncedThemePayload]]
        var hashByDesktop: [String: String]
    }

    private let queue = DispatchQueue(label: "com.ion.remote.synced-themes")
    private var byDesktop: [String: [SyncedThemePayload]] = [:]
    private var hashByDesktop: [String: String] = [:]

    private let storeURL: URL
    private let assetsRoot: URL

    init(directory: URL? = nil) {
        let docs = directory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        storeURL = docs.appendingPathComponent("synced-themes.json")
        assetsRoot = docs.appendingPathComponent("synced-theme-assets", isDirectory: true)
        load()
    }

    // MARK: - Load / save

    private func load() {
        do {
            let data = try Data(contentsOf: storeURL)
            let file = try JSONDecoder().decode(StoreFile.self, from: data)
            byDesktop = file.byDesktop
            hashByDesktop = file.hashByDesktop
            DiagnosticLog.log("synced themes loaded", tag: "theme.store", fields: [
                "count": String(byDesktop.values.map(\.count).reduce(0, +)),
                "status": String(byDesktop.keys.count)
            ])
        } catch CocoaError.fileReadNoSuchFile {
            // First launch — nothing persisted yet. Expected, not an error.
        } catch {
            DiagnosticLog.log("synced themes store unreadable; resetting", tag: "theme.store",
                              level: .warn, fields: ["reason": String(describing: error)])
            byDesktop = [:]
            hashByDesktop = [:]
        }
    }

    private func save() {
        do {
            let data = try JSONEncoder().encode(StoreFile(byDesktop: byDesktop, hashByDesktop: hashByDesktop))
            try data.write(to: storeURL, options: .atomic)
        } catch {
            DiagnosticLog.log("synced themes save failed", tag: "theme.store",
                              level: .error, fields: ["reason": String(describing: error)])
        }
    }

    // MARK: - Manifest ingestion

    /// Replace the theme set for one desktop (snapshot semantics). Returns
    /// the asset descriptors whose bytes are missing locally so the caller
    /// can issue `desktop_request_theme_asset` fetches. A manifest whose
    /// hash matches the stored one still recomputes missing assets (cheap)
    /// but skips re-persisting the payload file.
    func replaceThemes(
        _ themes: [SyncedThemePayload],
        hash: String,
        forDesktop desktopId: String
    ) -> [(themeId: String, descriptor: SyncedThemeAssetDescriptor)] {
        queue.sync {
            let unchanged = hashByDesktop[desktopId] == hash
            if !unchanged {
                byDesktop[desktopId] = themes
                hashByDesktop[desktopId] = hash
                save()
                pruneAssets(for: desktopId, keeping: themes)
                DiagnosticLog.log("synced themes replaced", tag: "theme.store", fields: [
                    "status": desktopId,
                    "count": String(themes.count)
                ])
            }
            var missing: [(String, SyncedThemeAssetDescriptor)] = []
            for theme in themes {
                for descriptor in theme.assets ?? [] {
                    if !FileManager.default.fileExists(atPath: assetURL(desktopId: desktopId, themeId: theme.id, descriptor: descriptor).path) {
                        missing.append((theme.id, descriptor))
                    }
                }
            }
            return missing
        }
    }

    /// All persisted themes across every paired desktop, deduplicated by
    /// theme id (the desktop synced most recently wins on collision — in
    /// practice enterprise packs share ids across a fleet's desktops, so
    /// collisions carry identical content).
    func allThemes() -> [SyncedThemePayload] {
        queue.sync {
            var seen = Set<String>()
            var out: [SyncedThemePayload] = []
            for themes in byDesktop.values {
                for theme in themes where !seen.contains(theme.id) {
                    seen.insert(theme.id)
                    out.append(theme)
                }
            }
            return out.sorted { $0.id < $1.id }
        }
    }

    // MARK: - Assets

    private func assetURL(desktopId: String, themeId: String, descriptor: SyncedThemeAssetDescriptor) -> URL {
        assetsRoot
            .appendingPathComponent(desktopId, isDirectory: true)
            .appendingPathComponent("\(themeId).\(descriptor.slot).\(descriptor.sha256)")
    }

    /// Persist one fetched asset (base64 data URL from
    /// `desktop_theme_asset_content`). Returns true on success.
    @discardableResult
    func storeAsset(desktopId: String, themeId: String, slot: String, sha256: String, dataUrl: String) -> Bool {
        guard let commaIndex = dataUrl.firstIndex(of: ","),
              let bytes = Data(base64Encoded: String(dataUrl[dataUrl.index(after: commaIndex)...])) else {
            DiagnosticLog.log("theme asset dataUrl undecodable", tag: "theme.store",
                              level: .warn, fields: ["path": themeId, "reason": slot])
            return false
        }
        return queue.sync {
            let dir = assetsRoot.appendingPathComponent(desktopId, isDirectory: true)
            let url = dir.appendingPathComponent("\(themeId).\(slot).\(sha256)")
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try bytes.write(to: url, options: .atomic)
                DiagnosticLog.log("theme asset stored", tag: "theme.store", fields: [
                    "path": themeId, "reason": slot, "count": String(bytes.count)
                ])
                return true
            } catch {
                DiagnosticLog.log("theme asset write failed", tag: "theme.store",
                                  level: .error, fields: ["path": themeId, "reason": String(describing: error)])
                return false
            }
        }
    }

    /// Resolve the on-disk bytes for a theme's asset slot, searching every
    /// desktop's cache (themes are deduplicated by id across desktops).
    func assetData(themeId: String, slot: String) -> Data? {
        queue.sync {
            for (desktopId, themes) in byDesktop {
                guard let theme = themes.first(where: { $0.id == themeId }),
                      let descriptor = theme.assets?.first(where: { $0.slot == slot }) else { continue }
                let url = assetURL(desktopId: desktopId, themeId: themeId, descriptor: descriptor)
                if let data = try? Data(contentsOf: url) { return data }  // absent file = not yet fetched; expected
            }
            return nil
        }
    }

    /// Remove asset files that no longer correspond to a live
    /// (themeId, slot, sha256) triple for this desktop — uninstalled themes
    /// and stale-hash versions both prune here.
    private func pruneAssets(for desktopId: String, keeping themes: [SyncedThemePayload]) {
        let dir = assetsRoot.appendingPathComponent(desktopId, isDirectory: true)
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }  // no dir yet = nothing to prune
        var live = Set<String>()
        for theme in themes {
            for descriptor in theme.assets ?? [] {
                live.insert("\(theme.id).\(descriptor.slot).\(descriptor.sha256)")
            }
        }
        for file in files where !live.contains(file) {
            do {
                try FileManager.default.removeItem(at: dir.appendingPathComponent(file))
                DiagnosticLog.log("theme asset pruned", tag: "theme.store", fields: ["path": file])
            } catch {
                DiagnosticLog.log("theme asset prune failed", tag: "theme.store",
                                  level: .warn, fields: ["path": file, "reason": String(describing: error)])
            }
        }
    }
}
