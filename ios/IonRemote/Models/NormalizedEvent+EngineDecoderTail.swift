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
            let schema = try container.decode([DesktopSettingSchemaEntry].self, forKey: .schema)
            let groups = try container.decode([DesktopSettingGroupDescriptor].self, forKey: .groups)
            let newConversationPolicy = try container.decodeIfPresent(RemoteNewConversationPolicy.self, forKey: .newConversationPolicy)
            // themePolicy: enterprise theme enforcement (absent/null on
            // unmanaged desktops and older desktop builds — decodes nil).
            let themePolicy = try container.decodeIfPresent(RemoteThemePolicy.self, forKey: .themePolicy)
            return .desktopSettingsSnapshot(settings: settings, schema: schema, groups: groups, newConversationPolicy: newConversationPolicy, themePolicy: themePolicy)

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

        case .engineIntercept:
            // Intercept event routed from the desktop after it has applied
            // its own focus-checking and redirect-orchestration logic.
            // iOS renders an inline banner in the engine conversation.
            // Fields match the desktop RemoteEvent wire shape exactly:
            // tabId (required), level, title, message, source?, metadata?.
            // `level` and `title` default to empty strings on missing values
            // (older desktops should never omit them, but be safe).
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let level = try container.decodeIfPresent(String.self, forKey: .level) ?? "banner"
            let title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let source = try container.decodeIfPresent(String.self, forKey: .source)
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineIntercept(
                tabId: tabId,
                instanceId: instanceId,
                level: level,
                title: title,
                message: message,
                source: source,
                metadata: metadata
            )

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

        case .engineImageContent:
            // engine_image_content — a run-produced image (tool-returned or
            // provider-generated). The engine saves bytes to disk and emits
            // the FILE PATH, never base64 (its never-base64-on-the-wire
            // contract). iOS attaches the path to the owning message and
            // fetches bytes lazily via RemoteImageFetcher. tabId/instanceId
            // follow the standard engine event shape; path/mediaType/source/
            // toolId mirror the Go ImageContentEvent json tags. source is
            // "tool" (with toolId) or "provider" (no toolId). contentHash is
            // the SHA-256 of the decoded bytes — absent on legacy attachments
            // without a hash; handleEngineImageContent treats absence as "not
            // identifiable as a duplicate" rather than guessing.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let path = try container.decode(String.self, forKey: .path)
            let mediaType = try container.decodeIfPresent(String.self, forKey: .mediaType) ?? "image/png"
            let contentHash = try container.decodeIfPresent(String.self, forKey: .contentHash)
            let source = try container.decodeIfPresent(String.self, forKey: .source) ?? "tool"
            let toolId = try container.decodeIfPresent(String.self, forKey: .toolId)
            return .engineImageContent(tabId: tabId, instanceId: instanceId, path: path, mediaType: mediaType, contentHash: contentHash, source: source, toolId: toolId)


        default:
            return nil
        }
    }

}
