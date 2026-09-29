import Foundation

// MARK: - Engine event decode (registry, command results, export, intercept, images)

// Second half of the engine-event decoder, split from
// NormalizedEvent+EngineDecoder.swift to keep both files under the 600-line
// Swift cap. `decodeEngineTail` handles the arms the primary decoder does not
// claim; the primary decoder delegates to it before falling through to nil, so
// the two together cover exactly the same set as before the split.
//
// Both functions are members of the same `extension RemoteEvent`, so there is
// no access-control boundary between them.

extension RemoteEvent {

    /// Decode the tail group of engine events. Returns nil when `type` is not
    /// one of these arms, which is the primary decoder's signal to give up.
    static func decodeEngineTail(
        type: TypeKey,
        container: KeyedDecodingContainer<RemoteEvent.CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .engineCommandRegistry:
            // Slash-command registry snapshot. Snapshot semantics —
            // REPLACE the cached set wholesale; never merge. Empty
            // `commands` is the authoritative "no extension commands"
            // signal, not a no-op. iOS does not yet act on this — the
            // desktop's prompt pipeline owns the routing-hint cache —
            // but we decode cleanly so the wire stays uniform.
            // Field correlation: tabId/instanceId are session
            // correlators; `commands` is the full snapshot payload.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let commands = try container.decodeIfPresent([EngineCommandListing].self, forKey: .commands) ?? []
            return .engineCommandRegistry(
                tabId: tabId,
                instanceId: instanceId,
                commands: commands
            )

        case .engineCommandResult:
            // Result of an engine SendCommand dispatch. The three
            // payload fields are independently optional:
            //   - `message` may be empty when the dispatch produced no
            //     human-readable note (most success cases).
            //   - `command` may be empty for the catch-all unknown-
            //     command emit before the engine resolved the name.
            //   - `commandError` is set only on failure (extension
            //     error or "unknown_command").
            // The desktop's prompt pipeline awaits this event to decide
            // dispatch success vs fallback; iOS does not act on it
            // today.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message)
            let command = try container.decodeIfPresent(String.self, forKey: .command)
            let commandError = try container.decodeIfPresent(String.self, forKey: .commandError)
            return .engineCommandResult(
                tabId: tabId,
                instanceId: instanceId,
                message: message,
                command: command,
                commandError: commandError
            )

        case .engineExport:
            // Engine has rendered a /export payload. iOS surfaces it
            // via a share sheet (see SessionViewModel handler). The
            // engine reports the resolved format on `exportFormat`
            // (markdown by default) so the share sheet can attach a
            // correctly-typed file; nil when the engine predates the field.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decode(String.self, forKey: .message)
            let exportFormat = try container.decodeIfPresent(String.self, forKey: .exportFormat)
            return .engineExport(
                tabId: tabId,
                instanceId: instanceId,
                message: message,
                exportFormat: exportFormat
            )

        case .desktopSettingsSnapshot:
            // Per-desktop user-preferences projection. The whole payload
            // is wholesale-replace: SessionViewModel discards its
            // previous snapshot and adopts this one verbatim. iOS does
            // not merge values across snapshots — same semantics as
            // engine_agent_state. See DesktopSettingsModel.swift for
            // the higher-level state struct the view binds to.
            //
            // `newConversationPolicy` is optional — absent/null on older desktop
            // builds that predate #256 enterprise projection. Decodes
            // to nil in that case (forward-compat, no picker regression).
            let settings = try container.decode([String: AnyCodable].self, forKey: .settings)
            let schema = try container.decode([ServerSettingSchemaEntry].self, forKey: .schema)
            let groups = try container.decode([ServerSettingGroupDescriptor].self, forKey: .groups)
            let newConversationPolicy = try container.decodeIfPresent(RemoteNewConversationPolicy.self, forKey: .newConversationPolicy)
            // themePolicy: enterprise theme enforcement (absent/null on
            // unmanaged desktops and older desktop builds — decodes nil).
            let themePolicy = try container.decodeIfPresent(RemoteThemePolicy.self, forKey: .themePolicy)
            let canManageEnvironment = try container.decodeIfPresent(Bool.self, forKey: .canManageEnvironment)
            let pages = try container.decodeIfPresent([ServerSettingsPage].self, forKey: .pages)
            return .desktopSettingsSnapshot(settings: settings, schema: schema, groups: groups, newConversationPolicy: newConversationPolicy, themePolicy: themePolicy, canManageEnvironment: canManageEnvironment, pages: pages)

        case .desktopThemeManifest:
            // Custom theme-pack sync — replace-wholesale per desktop.
            // SyncedThemeStore persists the payload keyed by the sending
            // desktop's device id so themes work offline and desktop A's
            // manifest never prunes desktop B's themes.
            let themes = try container.decode([SyncedThemePayload].self, forKey: .themes)
            let hash = try container.decode(String.self, forKey: .hash)
            return .desktopThemeManifest(themes: themes, hash: hash)

        case .desktopThemeAssetContent:
            // Lazy asset fetch response. ok=false → asset unknown/unreadable
            // on the desktop; the theme still renders tokens-only.
            let themeId = try container.decode(String.self, forKey: .themeId)
            let slot = try container.decode(String.self, forKey: .slot)
            let ok = try container.decode(Bool.self, forKey: .ok)
            let sha256 = try container.decodeIfPresent(String.self, forKey: .sha256)
            let dataUrl = try container.decodeIfPresent(String.self, forKey: .dataUrl)
            return .desktopThemeAssetContent(themeId: themeId, slot: slot, ok: ok, sha256: sha256, dataUrl: dataUrl)

        case .desktopContextBreakdown:
            // desktop_context_breakdown — forwarded by the desktop from the engine's
            // context-analysis pass. The full payload decodes under a single
            // `contextBreakdown` key so the struct is self-contained and forward-
            // compatible (new fields land in ContextBreakdownPayload without touching
            // the CodingKeys enum here). tabId and instanceId follow the standard pattern.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let payload = try container.decode(ContextBreakdownPayload.self, forKey: .contextBreakdown)
            return .desktopContextBreakdown(tabId: tabId, instanceId: instanceId, contextBreakdown: payload)

        default:
            return nil
        }
    }

}
