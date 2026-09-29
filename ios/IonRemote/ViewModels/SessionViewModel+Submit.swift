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
    /// - Pending bubble + pinned prompt + status are all driven the same way
    ///   for both tab types; attachment-marker content is built whenever
    ///   attachments are present (data), independent of tab type.
    @MainActor
    func submit(tabId: String, text: String, attachments: [CommandAttachment]? = nil) {
        // A locked conversation (auto-generated conflict fix) accepts no
        // further prompts. The input bar is already replaced with a notice
        // (ConversationView+InputBar); this guard covers every other entry
        // point (voice, keyboard shortcut, future callers), mirroring the
        // desktop's submit() guard. The desktop refuses too — this just
        // avoids an optimistic bubble for a message that will be dropped.
        if tab(for: tabId)?.inputLocked == true {
            DiagnosticLog.log("submit blocked: conversation is input-locked", tag: "session", level: .warn,
                              fields: ["tab_id": String(tabId.prefix(8))])
            return
        }

        // There is no way to steer a compaction in progress — it is not a
        // turn a queued prompt could interrupt or redirect. The input bar
        // already disables Send for this (ConversationView+InputBar.cannotSend);
        // this guard covers every other entry point (voice, keyboard shortcut,
        // future callers), mirroring the desktop's submit() guard. The desktop
        // refuses too — this just avoids an optimistic bubble for a message
        // that will be dropped.
        if tab(for: tabId)?.isCompacting == true {
            DiagnosticLog.log("submit blocked: conversation is being compacted", tag: "session", level: .warn,
                              fields: ["tab_id": String(tabId.prefix(8))])
            return
        }

        // DATA, not a type branch: nil for a plain CLI tab (no instanceId on
        // the wire ⇒ desktop CLI pipeline), the active conversation-instance id
        // for an extension-backed tab (instanceId present ⇒ desktop engine
        // pipeline). See resolveSubmitInstanceId.
        let instanceId = resolveSubmitInstanceId(tabId: tabId)

        // Stable client message id. The pending bubble carries it as its id and
        // the prompt carries it on the wire; the server stamps the row it makes
        // for this prompt with the same `clientMsgId`, which is how the bubble
        // knows its row has arrived (SessionViewModel+PendingPrompts.swift).
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
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].lastRunDurationMs = nil
            tabs[idx].lastRunReason = nil
            if tabs[idx].status != .running {
                tabs[idx].status = .connecting
            }
        }

        // Show the prompt at once, before the server has made its row. It is
        // held apart from the transcript (the pending prompt overlay) and
        // leaves when the server's row for it arrives.
        //
        // The content string is built the same way the server builds it before
        // storing: each attachment becomes a `[Attached <type>: <path>]`
        // marker line prepended to the user text, separated by a blank line. The
        // user bubble parses those markers and renders each path as an inline
        // attachment image, finding the local bytes already primed under the
        // server path by the upload-result handler.
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
                    path: att.path,
                    contentHash: att.contentHash
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
            // the * 1000 the pending bubble briefly shows "56 years ago"
            // before the server's row replaces it.
            timestamp: Date().timeIntervalSince1970 * 1000,
            source: .remote
        )
        optimistic.attachments = optimisticAttachments
        optimistic.deliveryState = .queued
        // Mid-turn steer: the tab was already running when the user sent this,
        // so the server routes it through the engine's steer path rather than
        // opening a new turn. The server's row carries the steer state from
        // there on.
        if tabs.first(where: { $0.id == tabId })?.status == .running {
            optimistic.steerPending = true
        }
        // Slash-command provenance on the pending bubble. When the raw text
        // starts with a `/command`, populate the metadata fields so the pill
        // renders immediately; the server's row carries the canonical
        // metadata. Uses the same parseSlashCommand that EngineMessageRow
        // consults for the fallback path.
        if let slash = parseSlashCommand(text) {
            optimistic.slashCommand = slash.command
            optimistic.slashArgs = slash.args
        }
        DiagnosticLog.log("optimistic insert", tag: "session.submit", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": String(clientMsgId.prefix(8)),
            "count": instanceId ?? "nil"
        ])
        addPendingPrompt(tabId: tabId, optimistic)

        // The single, unified wire command. instanceId is the data field that
        // selects the server pipeline; nil is dropped on encode. clientMsgId
        // is the pending bubble's id, stamped by the server on the row it makes.
        // The prompt's trace starts here; the span ends on the server's answer
        // (handlePromptResult).
        let span = PromptTraceBook.shared.open(clientMsgId: clientMsgId, tabId: tabId, conversationId: tab(for: tabId)?.conversationId)
        send(.prompt(
            tabId: tabId, text: text, clientMsgId: clientMsgId, attachments: attachments, instanceId: instanceId,
            traceparent: span.traceparent
        ), intent: .userInitiated)
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
    ///   server's `setTabModel` action applies the override to the tab's ACTIVE
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
    func setModel(tabId: String, model: String, providerId: String = "") {
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
        // Single unified wire command for every tab type. providerId, when
        // known, lets the server qualify the wire model id so this explicit
        // pick can never be silently rerouted by the operator's configured
        // defaultProvider (see server's resolvePromptModel/send-slice.ts).
        send(.setTabModel(tabId: tabId, model: model, providerId: providerId.isEmpty ? nil : providerId), intent: .userInitiated)
    }

    @MainActor
    func sendPrompt(tabId: String, text: String, attachments: [CommandAttachment]? = nil) {
        // Retained as a thin alias of the unified submit path for the existing
        // call sites that name `sendPrompt` directly. There is no separate plain
        // wire shape anymore — everything funnels through `submit`.
        submit(tabId: tabId, text: text, attachments: attachments)
    }
}
