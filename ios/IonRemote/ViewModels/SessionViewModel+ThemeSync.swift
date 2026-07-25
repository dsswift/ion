import Foundation

// MARK: - Theme-pack sync handlers
//
// Split from SessionViewModel+EventHandlers.swift at the 600-line cap.
// Routes desktop_theme_manifest / desktop_theme_asset_content payloads and
// the settings-snapshot themePolicy into SyncedThemeStore + ThemeManager.

extension SessionViewModel {

    /// Custom theme-pack sync. Replace-wholesale per desktop: the store
    /// keys the payload by the sending desktop's device id so syncing here
    /// never prunes another paired desktop's themes. Assets whose sha256
    /// misses the local cache are fetched lazily via
    /// desktop_request_theme_asset.
    func handleThemeManifest(themes: [SyncedThemePayload], hash: String) {
        guard let desktopId = activeDeviceId else {
            DiagnosticLog.log("theme manifest without active device; dropped", tag: "session.events",
                              level: .warn, fields: ["count": String(themes.count)])
            return
        }
        let missing = SyncedThemeStore.shared.replaceThemes(themes, hash: hash, forDesktop: desktopId)
        DiagnosticLog.log("theme manifest applied", tag: "session.events", fields: [
            "count": String(themes.count),
            "status": hash,
            "reason": String(missing.count)
        ])
        themeManager?.reloadCustomThemes(SyncedThemeStore.shared.allThemes())
        for (themeId, descriptor) in missing {
            send(.requestThemeAsset(themeId: themeId, slot: descriptor.slot))
        }
    }

    /// Lazy asset fetch response. Stores the bytes keyed by (desktop,
    /// theme, slot, sha) and rebuilds the registry so a theme currently
    /// rendering tokens-only picks up its background/logo immediately.
    func handleThemeAssetContent(themeId: String, slot: String, ok: Bool, sha256: String?, dataUrl: String?) {
        guard ok, let sha256, let dataUrl else {
            DiagnosticLog.log("theme asset fetch failed on desktop", tag: "session.events",
                              level: .warn, fields: ["path": themeId, "reason": slot])
            return
        }
        guard let desktopId = activeDeviceId else { return }  // asset without a pairing context cannot be cached
        if SyncedThemeStore.shared.storeAsset(desktopId: desktopId, themeId: themeId, slot: slot, sha256: sha256, dataUrl: dataUrl) {
            themeManager?.reloadCustomThemes(SyncedThemeStore.shared.allThemes())
        }
    }

    /// Enterprise theme policy from the settings snapshot: locked →
    /// enforce on iOS too (the enforced id resolves against built-ins +
    /// synced packs; an unresolvable id falls back to Ion Dark in
    /// ThemeManager). Unlocked or absent → clear any prior enforcement so
    /// the user's own selection resumes. Every snapshot re-evaluates, so
    /// lifting the policy on the desktop propagates live.
    func applyThemePolicy(_ themePolicy: RemoteThemePolicy?) {
        if let themePolicy {
            DiagnosticLog.log("theme policy received", tag: "session.events", fields: [
                "status": String(themePolicy.locked),
                "reason": themePolicy.themeId
            ])
        }
        themeManager?.setEnforcedTheme(themePolicy?.locked == true ? themePolicy?.themeId : nil)
    }
}
