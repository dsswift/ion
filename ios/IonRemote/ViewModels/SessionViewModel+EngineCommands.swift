import Foundation

// MARK: - Engine Commands
//
// Extracted from SessionViewModel+Commands.swift to keep that file under the
// Swift 600-line cap once submitEnginePrompt grew an optimistic-insert block
// (mirroring the CLI path's optimistic insert in sendPrompt). See
// CLAUDE.md → "When a file exceeds the cap": split along natural seams
// rather than collapsing comments. The Engine Commands section is a
// cohesive, self-contained group of methods that all delegate to .engine*
// RemoteCommand variants, so it splits cleanly here.

extension SessionViewModel {

    func createEngineTab(workingDirectory: String? = nil, profileId: String? = nil) {
        let dir = workingDirectory ?? defaultBaseDirectory
        awaitingLocalTabCreation = true
        send(.createEngineTab(workingDirectory: dir, profileId: profileId))
    }

    @MainActor
    func submitEnginePrompt(tabId: String, text: String, attachments: [CommandAttachment]? = nil) {
        let key = engineCompoundKey(tabId: tabId)
        enginePinnedPrompt[key] = text
        // Set tab running
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .running
        }
        let instanceId = activeEngineInstance[tabId] ?? engineInstances[tabId]?.first?.id

        // Optimistic local insert so the user's message appears immediately
        // (with inline image preview when attachments are present) rather than
        // waiting for the desktop to echo it back via engine_conversation_history
        // on the next conversation reload. Mirrors the CLI path's optimistic
        // insert in sendPrompt (SessionViewModel+Commands.swift), and the
        // desktop renderer's submitEnginePrompt in engine-slice.ts which does
        // the same thing on its side. There is no engine_user_message wire
        // event today; the desktop never broadcasts the user role for engine
        // tabs (see desktop's prompt-pipeline-renderer.ts:emitRemoteMessageAdded
        // which explicitly skips role='user' when isEngineTab).
        //
        // The content string is built the same way the desktop builds it in
        // remote/handlers/engine.ts before broadcasting REMOTE_ENGINE_PROMPT:
        // each attachment becomes a `[Attached <type>: <path>]` marker line
        // prepended to the user text, separated by a blank line. The
        // engineUserBubble parses those markers via parseAttachmentSegments
        // and renders each path as an InlineAttachmentImage, which finds the
        // local bytes already primed under the desktop path by the upload
        // result handler (EngineView+Attachments.swift consumeUploadResults).
        //
        // The guard on engineConversationLoaded mirrors the CLI guard in
        // sendPrompt: skip the optimistic insert when the engine conversation
        // hasn't been loaded yet, because the engine is about to push
        // engineConversationHistory itself and an unloaded view would
        // briefly show the optimistic message then have it replaced by the
        // canonical history (visible flicker).
        if engineConversationLoaded.contains(key) {
            let optimisticContent: String
            let optimisticAttachments: [MessageAttachment]?
            if let attachments, !attachments.isEmpty {
                let markers = attachments
                    .map { "[Attached \($0.type): \($0.path)]" }
                    .joined(separator: "\n")
                optimisticContent = "\(markers)\n\n\(text)"
                optimisticAttachments = attachments.map { att in
                    MessageAttachment(
                        id: UUID().uuidString,
                        type: AttachmentType(rawValue: att.type) ?? .file,
                        name: att.name,
                        path: att.path
                    )
                }
            } else {
                optimisticContent = text
                optimisticAttachments = nil
            }
            var optimistic = Message(
                id: UUID().uuidString,
                role: .user,
                content: optimisticContent,
                // Milliseconds since epoch -- matches every other timestamp
                // insertion in iOS (see sendPrompt, EngineEvents handlers,
                // NormalizedEvent+Lifecycle, RemoteCommand+Encode) and the
                // ms shape MessageBubble.relativeTimestamp divides by 1000
                // to reconstruct seconds. Without * 1000 the bubble shows
                // "56 years ago" until the canonical history arrives.
                timestamp: Date().timeIntervalSince1970 * 1000,
                source: .remote
            )
            optimistic.attachments = optimisticAttachments
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(optimistic) }
        }

        send(.enginePrompt(tabId: tabId, text: text, instanceId: instanceId, attachments: attachments))
    }

    func setTabModel(tabId: String, model: String) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].modelOverride = model
        }
        send(.setTabModel(tabId: tabId, model: model))
    }

    func setPreferredModelDefault(_ model: String) {
        preferredModel = model
        send(.setPreferredModel(model: model))
    }

    func setEngineDefaultModelDefault(_ model: String) {
        engineDefaultModel = model
        send(.setEngineDefaultModel(model: model))
    }

    @MainActor
    func setEngineModel(tabId: String, model: String) {
        let instanceId = activeEngineInstance[tabId]
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.modelOverride = model }
        send(.engineSetModel(tabId: tabId, model: model, instanceId: instanceId))
    }

    func abortEngine(tabId: String) {
        let instanceId = activeEngineInstance[tabId]
        send(.engineAbort(tabId: tabId, instanceId: instanceId))
    }

    func respondEngineDialog(tabId: String, dialogId: String, value: String) {
        let key = engineCompoundKey(tabId: tabId)
        engineDialogs[key] = nil
        let instanceId = activeEngineInstance[tabId]
        send(.engineDialogResponse(tabId: tabId, dialogId: dialogId, value: value, instanceId: instanceId))
    }
}
