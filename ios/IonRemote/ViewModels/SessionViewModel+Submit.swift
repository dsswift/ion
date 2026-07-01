import Foundation

// MARK: - Unified prompt submit & model override
//
// Extracted from SessionViewModel+Commands.swift to keep that file under the
// Swift 600-line cap after the #256 follow-up collapsed the engine-vs-plain
// submit / setModel forks into single branch-free paths (the unified bodies
// grew the optimistic-insert + documentation that pushed Commands.swift over
// the cap). See CLAUDE.md → "When a file exceeds the cap": split along natural
// seams rather than collapsing comments. Submit + model override is a cohesive,
// self-contained group, so it splits cleanly here.
//
// The whole point of this file is the "no behavior branches on tab type"
// standard: `submit` and `setModel` each have exactly ONE code path and emit
// ONE wire command for every conversation tab — plain or extension-backed. The
// only per-tab difference is DATA (the `instanceId` field on `.prompt`), never
// a fork.

extension SessionViewModel {

    /// Unified prompt submit (#256 follow-up). Every conversation tab — plain
    /// or extension-backed — submits through this SINGLE path. There is no
    /// engine-vs-plain code fork: the only difference is DATA.
    ///
    /// - Wire command: always the unified `.prompt` (`desktop_prompt`).
    /// - `instanceId`: the lone per-tab DATA difference. The desktop's
    ///   `handlePrompt` routes a prompt into the engine pipeline iff the wire
    ///   carries an `instanceId` (`cmd.instanceId !== undefined`), and into the
    ///   CLI pipeline otherwise. So an extension-backed tab — which has an
    ///   active conversation instance — passes that instance id, while a plain
    ///   CLI tab omits it. This is expressed as a data field (present/absent),
    ///   not a branch on tab type: `resolveSubmitInstanceId` returns nil unless
    ///   the tab is engine-hosted, and a nil `instanceId` is simply dropped from
    ///   the encoded JSON (`encodeIfPresent`).
    /// - Optimistic insert + pinned prompt + status are all driven the same way
    ///   for both tab types; attachment-marker content is built whenever
    ///   attachments are present (data), independent of tab type.
    @MainActor
    func submit(tabId: String, text: String, attachments: [CommandAttachment]? = nil) {
        // DATA, not a type branch: nil for a plain CLI tab (no instanceId on
        // the wire ⇒ desktop CLI pipeline), the active conversation-instance id
        // for an extension-backed tab (instanceId present ⇒ desktop engine
        // pipeline). See resolveSubmitInstanceId.
        let instanceId = resolveSubmitInstanceId(tabId: tabId)

        // Stable client message id. The SAME id is used for the optimistic
        // local insert AND sent on the wire as `clientMsgId`, so the desktop's
        // user-message echo (`desktop_message_added`) carries this exact id back.
        // iOS `handleMessageAdded` reconciles by id and REPLACES the optimistic
        // bubble in place instead of appending a second one. Without a shared id
        // the optimistic insert used a throwaway UUID the echo could never match,
        // so the user's message rendered twice until a full history reload
        // deduped it. This is the single seam that fixes outgoing duplication for
        // both tab types: the desktop CLI echo resolves `id = cmd.clientMsgId`
        // (tabs-prompt.ts) and the engine echo threads the same id through reqId.
        let clientMsgId = UUID().uuidString

        // Pin the just-sent prompt so it renders above the scrollback while the
        // turn runs. Data-gated in the view (`enginePinnedPrompt[tabId]`), so it
        // is harmless for tabs that don't surface it.
        enginePinnedPrompt[tabId] = text

        // Optimistic status: the prompt is in flight to the desktop. We show
        // activity immediately rather than letting the user stare at their sent
        // message until the relay round-trips. Guard against downgrading from
        // .running (a queued prompt sent while a turn is already active).
        // Mirrors the desktop send-slice which sets a connecting/running state
        // on submit; the next snapshot reconciles the authoritative value.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }), tabs[idx].status != .running {
            tabs[idx].status = .connecting
        }

        // Optimistic local insert so the user's message (with inline image
        // previews when attachments are present) appears immediately — dismisses
        // the empty state and enables scroll-to-bottom — rather than waiting for
        // the desktop to echo it back. Mirrors the desktop renderer's optimistic
        // insert.
        //
        // The insert fires UNCONDITIONALLY (no `conversationLoaded` gate). The
        // previous gate skipped the insert on fresh or just-reloaded conversations
        // where `loadConversation` had removed the tab from `conversationLoaded`
        // and the history response had not yet returned — producing a MISSING
        // bubble until the desktop echo arrived over the relay round-trip. This
        // was near-guaranteed on a brand-new conversation's first prompt.
        //
        // Removing the gate is safe: `mutateConversationMessages` calls
        // `ensureMainInstance` internally, so writing before load creates the
        // instance correctly. When the full history response arrives via
        // `handleConversationHistory`, the merge logic retains any pending
        // optimistic messages not yet confirmed by a desktop echo (see
        // SessionViewModel+PermissionMessageEvents.swift). The desktop echo
        // then reconciles by `clientMsgId` (id-replace, not append) leaving
        // exactly one bubble.
        //
        // The content string is built the same way the desktop builds it before
        // broadcasting: each attachment becomes a `[Attached <type>: <path>]`
        // marker line prepended to the user text, separated by a blank line. The
        // user bubble parses those markers and renders each path as an inline
        // attachment image, finding the local bytes already primed under the
        // desktop path by the upload-result handler.
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
            id: clientMsgId,
            role: .user,
            content: optimisticContent,
            // Milliseconds since epoch — matches every other timestamp
            // insertion in iOS (EngineEvents handlers, EventHandlers,
            // NormalizedEvent+Lifecycle, RemoteCommand+Encode) and the ms
            // shape MessageBubble.relativeTimestamp divides by 1000 to
            // reconstruct seconds for Date(timeIntervalSince1970:). Without
            // the * 1000 the optimistic bubble briefly shows "56 years ago"
            // before the desktop echoes the canonical message back.
            timestamp: Date().timeIntervalSince1970 * 1000,
            source: .remote
        )
        optimistic.attachments = optimisticAttachments
        // Slash-command provenance on the optimistic insert. When the raw
        // text starts with a `/command`, populate the metadata fields so the
        // pill renders immediately. The desktop echo and eventual history
        // reload will carry the canonical metadata; this ensures the pill
        // is visible from the first frame. Uses the same parseSlashCommand
        // that EngineMessageRow consults for the fallback path.
        if let slash = parseSlashCommand(text) {
            optimistic.slashCommand = slash.command
            optimistic.slashArgs = slash.args
        }
        // Unified store write — lands on the tab's single ConversationInstanceInfo
        // regardless of tab type. ensureMainInstance (inside the mutator)
        // creates the instance if it doesn't exist yet.
        let targetInstanceId = conversationInstances[tabId]?.first?.id ?? "(will-create)"
        DiagnosticLog.log("OPTIMISTIC-INSERT: tabId=\(tabId.prefix(8)) clientMsgId=\(clientMsgId.prefix(8)) instanceId=\(targetInstanceId) wireInstanceId=\(instanceId ?? "nil")")
        mutateConversationMessages(tabId: tabId) { $0.append(optimistic) }

        // The single, unified wire command. instanceId is the data field that
        // selects the desktop pipeline; nil is dropped on encode. clientMsgId
        // carries the optimistic insert's id so the desktop echoes the user
        // message back under the same id and iOS reconciles by id (no duplicate).
        send(.prompt(tabId: tabId, text: text, clientMsgId: clientMsgId, attachments: attachments, instanceId: instanceId), intent: .userInitiated)
    }

    /// Resolve the `instanceId` to carry on a `.prompt` for the given tab.
    ///
    /// This is the single DATA seam that distinguishes a plain CLI prompt from
    /// an extension-backed one on the wire (the desktop routes by `instanceId`
    /// presence). It returns nil for a plain CLI tab so no `instanceId` is
    /// encoded, and the active conversation-instance id for an engine-hosted
    /// tab. Keeping this in one place means `submit` stays branch-free.
    @MainActor
    func resolveSubmitInstanceId(tabId: String) -> String? {
        guard tabs.first(where: { $0.id == tabId })?.hasEngineExtension == true else { return nil }
        return activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
    }

    /// Unified per-tab model override (#256 follow-up). Every conversation tab —
    /// plain or extension-backed — sets its model through this SINGLE path with
    /// no engine-vs-plain code fork.
    ///
    /// - Wire command: always `.setTabModel` (`desktop_set_tab_model`). The
    ///   desktop's `handleSetTabModel` applies the override to the tab's ACTIVE
    ///   conversation instance via `commitInstance` (which falls back to the
    ///   first instance when no active pointer is set), so it is correct for
    ///   both tab types post-#256 — every tab owns exactly one conversation
    ///   instance. The former `desktop_engine_set_model` path did the same thing
    ///   (its renderer `setEngineModel` also writes `modelOverride` on the
    ///   active instance) but early-returned when no active instance existed;
    ///   `desktop_set_tab_model` is the strictly more general of the two
    ///   already-equivalent commands, so it is the unified choice. No new wire
    ///   string was invented.
    /// - Optimistic local write: the model override lives on the tab's single
    ///   ConversationInstanceInfo. We write it there for every tab so the UI
    ///   updates instantly; plain tabs additionally mirror it onto
    ///   `tab.modelOverride` for the legacy tab-level reader.
    @MainActor
    func setModel(tabId: String, model: String) {
        // Optimistic write onto the tab's single conversation instance — the
        // unified home for the per-conversation model override (matches the
        // desktop store, which keeps modelOverride on the instance for every
        // tab type post-#256).
        mutateEngineInstance(tabId: tabId, instanceId: activeEngineInstance[tabId]) { $0.modelOverride = model }
        // Mirror onto the tab-level field for the plain reader path. Harmless
        // for engine tabs (which read the instance override). This preserves the
        // existing optimistic-UI contract pinned by UnifiedSubmitPathTests.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].modelOverride = model
        }
        // Single unified wire command for every tab type.
        send(.setTabModel(tabId: tabId, model: model), intent: .userInitiated)
    }

    @MainActor
    func sendPrompt(tabId: String, text: String, attachments: [CommandAttachment]? = nil) {
        // Retained as a thin alias of the unified submit path for the existing
        // call sites that name `sendPrompt` directly. There is no separate plain
        // wire shape anymore — everything funnels through `submit`.
        submit(tabId: tabId, text: text, attachments: attachments)
    }
}
