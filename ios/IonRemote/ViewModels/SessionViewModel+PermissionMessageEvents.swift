import Foundation

// MARK: - Permission / message event handlers
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the 600-line Swift cap. The handlers continue to be members of
// the same `extension SessionViewModel` and are dispatched from
// handleEvent in the original file.

extension SessionViewModel {

    @MainActor
    func handlePermissionRequest(tabId: String, instanceId: String? = nil, questionId: String, toolName: String, toolInput: [String: AnyCodable]?, options: [PermissionOption]) {
        let inputKeys = toolInput?.keys.sorted() ?? []
        let inputSummary = toolInput?.map { "\($0.key): \(type(of: $0.value.value))" }.joined(separator: ", ") ?? "nil"
        let hasEngineExtension = tabs.first(where: { $0.id == tabId })?.hasEngineExtension == true
        DiagnosticLog.log("permission request", tag: "session.perm", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": instanceId?.prefix(8).description ?? "nil",
            "question_id": String(questionId.prefix(16)),
            "tool": toolName,
            "count": String(inputKeys.count),
            "status": inputSummary,
            "agent": String(hasEngineExtension)
        ])

        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            // RC-19: a fresh permission request means a NEW special card for this
            // tab — clear any prior dismissal so the snapshot sweep / restored-card
            // path does not strip it as "already dismissed".
            dismissedLiveSpecialTabs.remove(tabId)
            if let instanceId {
                dismissedLiveSpecialTabs.remove("\(tabId):\(instanceId)")
            }
            // Normalize AnyCodable toolInput to Foundation types so the
            // card views can parse with simple `as?` casts. The Codable
            // decoder wraps nested values as [AnyCodable]/[String: AnyCodable],
            // but the card views expect Foundation types (NSArray/NSDictionary)
            // which is what JSONSerialization produces.
            var normalizedInput = toolInput
            if let input = toolInput,
               let data = try? JSONEncoder().encode(input),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                normalizedInput = dict.mapValues { AnyCodable($0) }
                let normalizedSummary = normalizedInput?.map { "\($0.key): \(type(of: $0.value.value))" }.joined(separator: ", ") ?? "nil"
                DiagnosticLog.log("permission request normalized tool input", tag: "session.perm", fields: [
                    "status": normalizedSummary
                ])
            } else {
                DiagnosticLog.log("PERM: handlePermissionRequest: normalization failed or skipped, using raw toolInput")
            }
            let request = PermissionRequest(
                questionId: questionId,
                toolName: toolName,
                toolInput: normalizedInput,
                options: options,
                instanceId: instanceId
            )
            DiagnosticLog.log("permission request queued", tag: "session.perm", fields: [
                "tab_id": String(tabId.prefix(8)),
                "count": String(self.tabs[idx].permissionQueue.count + 1)
            ])
            tabs[idx].permissionQueue.append(request)
        } else {
            DiagnosticLog.log("permission request tab not found", tag: "session.perm", level: .warn, fields: [
                "tab_id": String(tabId.prefix(8))
            ])
        }
    }

    /// Apply a `desktop_conversation_history` page.
    ///
    /// Replace-vs-prepend is discriminated by `before` — the desktop's ECHO of
    /// the REQUEST cursor from the `desktop_load_conversation` this page
    /// answers — NEVER by the response `cursor`. The response cursor is set on
    /// every page that has more history (it is the token for fetching the next
    /// older page), so the old `cursor != nil` branch made every
    /// fingerprint-heal response take the prepend path and prepend a duplicate
    /// page: message counts grew 132→172→212→252, one page per heal, producing
    /// an interlaced transcript.
    ///
    ///   - `before != nil` — older-page pagination: prepend only unseen rows.
    ///   - `before == nil` — first page / heal: wholesale REPLACE of the
    ///     persisted portion, preserving (1) the live tail (rows streamed after
    ///     the page was cut) and (2) optimistic user rows not yet persisted.
    @MainActor
    func handleConversationHistory(tabId: String, newMessages: [Message], hasMore: Bool, cursor: String?, before: String? = nil) {
        cancelLoadTimer(tabId: tabId)
        conversationLoadFailed.remove(tabId)
        loadingConversation.remove(tabId)
        conversationLoaded.insert(tabId)
        // RC-13: do NOT wipe the text_chunk accumulator (liveText) when this
        // apply is a reconnect/heal reload racing an active run. liveText backs
        // the legacy desktop_text_chunk path (older desktop builds) and the
        // tab-list preview; a reconnect snapshot bypasses the streaming guard and
        // can fire loadConversation mid-stream, and an unconditional clear here
        // blanked any in-flight accumulator until the next event. Clear it only on
        // a settled load (not reconnect, or tab not running) — a genuine first
        // load has no live stream to protect.
        let tabRunning = tabs.first(where: { $0.id == tabId })?.status == .running
            || tabs.first(where: { $0.id == tabId })?.status == .connecting
        if !(isReconnectSnapshot && tabRunning) {
            clearLiveText(tabId: tabId)
        }
        conversationHasMore[tabId] = hasMore
        conversationCursor[tabId] = cursor

        // Deduplicate incoming by message ID, keeping last occurrence (most
        // recent version).
        let incoming = deduplicateMessages(newMessages)
        let incomingIds = Set(incoming.map { $0.id })
        let current = conversationMessages(tabId)

        if before != nil {
            // Older-page pagination (user scrolled up): prepend only rows the
            // local list doesn't already hold, above the existing transcript.
            // Suppress the scroll-to-bottom the list would otherwise perform
            // on a count change — the user is reading older history.
            suppressScrollToBottom = true
            let currentIds = Set(current.map { $0.id })
            let newRows = incoming.filter { !currentIds.contains($0.id) }
            setConversationMessages(tabId: tabId, newRows + current)
        } else {
            // First page / fingerprint heal: the page is the authoritative
            // persisted transcript. Replace wholesale, preserving two classes
            // of local rows the page cannot carry yet:
            //
            // (1) The LIVE TAIL — rows streamed via live events after the page
            //     was cut on the desktop. Anchor on the LAST local row whose
            //     id appears in the page (history rows carry canonical engine
            //     tree-entry ids; live rows are re-keyed to the same ids by
            //     handleEngineMessageEnd): everything after the anchor is
            //     newer than the page. When no id anchors (a fully pre-canonical
            //     local list), fall back to rows STRICTLY newer than the
            //     page's last timestamp. Rows the page already contains are
            //     dropped from the tail (the page's version is canonical).
            //
            // (2) PENDING OPTIMISTIC user rows — written locally by `submit`
            //     (source == .remote) and not yet confirmed into the page. A
            //     bare replace would drop them, leaving no user bubble until
            //     the desktop echo round-trips (the MISSING symptom). They are
            //     the newest turns, so they go BELOW the history — the old
            //     code wrongly prepended them above it.
            //
            // Final shape: incoming + pendingOptimistic + liveTail.
            //
            // RC-9: an optimistic user row is "pending" (keep it) ONLY if the
            // page does not already contain it. The page contains it under the
            // CANONICAL entry id, which differs from the optimistic row's id (=
            // the clientMsgId this device sent) whenever the live re-key events
            // (user_turn_persisted / message_end) were dropped. So id-equality
            // alone (`!incomingIds.contains(id)`) wrongly kept the stale
            // optimistic row and appended it BELOW the assistant reply — the
            // duplicate-user bug. The desktop now annotates each history user row
            // with the clientMsgId it was submitted under (client-msg-id-map.ts);
            // match on that so an already-persisted optimistic row is recognized
            // and dropped regardless of id re-keying.
            let incomingClientMsgIds = Set(incoming.compactMap { $0.clientMsgId })
            // A local row is "already in the page" when the page holds it by
            // canonical id OR by the clientMsgId the desktop annotated onto the
            // persisted user row. This single predicate governs BOTH the pending
            // classification and the live-tail filter — a row already persisted
            // must be dropped from whichever path would otherwise re-add it.
            // (Checking only `pending` let a row whose real-time optimistic
            // timestamp exceeded the page's timestamps survive via the tail.)
            let isAlreadyInPage: (Message) -> Bool = { msg in
                if incomingIds.contains(msg.id) { return true }
                if let cid = msg.clientMsgId, incomingClientMsgIds.contains(cid) { return true }
                // The optimistic row's id IS the clientMsgId it sent, so match
                // the annotation against the row id too.
                if incomingClientMsgIds.contains(msg.id) { return true }
                return false
            }
            let isPendingOptimistic: (Message) -> Bool = { msg in
                guard msg.role == .user && msg.source == .remote else { return false }
                return !isAlreadyInPage(msg)
            }
            // Live-tail preservation is valid ONLY while a run is actively
            // streaming. Mid-run, the engine page is a point-in-time cut and rows
            // arriving as live deltas AFTER that cut are legitimately newer than
            // the page, so they must survive the wholesale replace. On a SETTLED
            // (idle) reload the page is the authoritative, complete transcript tail
            // to its end — preserving local rows the page does not contain
            // reintroduces stale content. That was the freeze bug: a disjoint stale
            // local slice (no id anchor) had its isLive rows kept and appended
            // BELOW the authoritative page, producing a fixed point whose tail
            // fingerprint never matched the desktop's, so the heal looped forever.
            // Gate the entire tail-candidate path on tabRunning; when not
            // streaming, tailCandidates stays empty and the merge replaces the
            // local transcript with exactly the desktop page.
            var tailCandidates: [Message] = []
            if tabRunning {
                if let anchorIdx = current.lastIndex(where: { incomingIds.contains($0.id) }) {
                    // Anchor found: everything after the last row the page also holds
                    // is newer than the page (the precise, preferred path).
                    tailCandidates = Array(current[(anchorIdx + 1)...])
                } else {
                    // RC-11: no id anchors (a fully pre-canonical local list). Prefer
                    // the STORED live boundary — rows appended by live events since the
                    // last history load carry isLive == true — over a timestamp
                    // estimate. The old `timestamp > max(incoming)` guess dropped the
                    // whole live tail when incoming had no timestamps (.max() nil) and
                    // dropped rows with nil/equal stamps (strict >, ?? 0): the "only
                    // the most recent turn" symptom. isLive is a fact that a row was
                    // streamed live — but it only means "newer than the page" WHILE the
                    // run is streaming (this branch). Applying it across a settled
                    // reload is the defect the tabRunning gate prevents.
                    let liveRows = current.filter { $0.isLive }
                    if !liveRows.isEmpty {
                        tailCandidates = liveRows
                    } else if let lastTs = incoming.compactMap({ $0.timestamp }).max() {
                        // Legacy fallback only when nothing is marked live (e.g. rows
                        // restored from a cache that predates the isLive flag).
                        tailCandidates = current.filter { ($0.timestamp ?? 0) > lastTs }
                    }
                }
            }
            let pending = current.filter(isPendingOptimistic)
            // RC-10: an assistant row whose id was never re-keyed to canonical
            // (dropped message_end) is not in incomingIds and is not pending, so
            // it survived in the tail and duplicated the canonical assistant row
            // already in the page. Drop a trailing tail assistant row whose
            // content matches a trailing incoming assistant row — content-match is
            // the correct desktop-independent dedup here (assistant rows carry no
            // client-minted id). Only compares against the page's last assistant
            // row to stay cheap and avoid collapsing legitimately repeated text.
            let incomingLastAssistantContent = incoming.last(where: { $0.role == .assistant })?.content
            let tail = tailCandidates.filter { msg in
                // Already persisted (by id or clientMsgId) → never re-add.
                if isAlreadyInPage(msg) { return false }
                if isPendingOptimistic(msg) { return false }
                if msg.role == .assistant,
                   let ic = incomingLastAssistantContent,
                   !ic.isEmpty, msg.content == ic {
                    return false
                }
                return true
            }
            let merged = incoming + pending + tail
            setConversationMessages(tabId: tabId, merged)

            // If the replace dropped the live `.thinking` row, clear the
            // in-progress accumulator so a late thinking_delta / block_end
            // can't target a message id that no longer exists in the list.
            // When the row survived in the live tail the id stays bound and
            // the stream continues seamlessly.
            if let liveThinkingId = thinkingMessageId(tabId),
               !merged.contains(where: { $0.id == liveThinkingId }) {
                clearThinkingAccumulator(forKey: tabId)
            }
        }

        // Log the last 3 messages for diagnostics (permission card restoration depends on message content).
        let allMsgs = conversationMessages(tabId)
        let tail = allMsgs.suffix(3)
        let tailSummary = tail.map { "role=\($0.role.rawValue) toolName=\($0.toolName ?? "nil") isTool=\($0.isTool) toolInput=\($0.toolInput?.prefix(60) ?? "nil")" }.joined(separator: " | ")
        DiagnosticLog.log("conversation history", tag: "session.convhist", fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(allMsgs.count),
            "reason": String(hasMore),
            "conversation_id": before?.prefix(8).description ?? "nil",
            "status": tailSummary
        ])
    }

    @MainActor
    func handleMessageAdded(tabId: String, message: Message) {
        // Always update tab preview for user/assistant messages (even if conversation isn't loaded).
        // Strip attachment markers before storing — message.content may carry
        // `[Attached image: PATH]` (pre-encode optimistic form) or
        // `[Attachment: NAME (content attached)]` (post-encode desktop echo form).
        // Without stripping, the tab row subtitle shows raw marker text rather than
        // the user's actual message. parseAttachmentSegments handles both forms and
        // returns the clean display text; fall back to the raw prefix for non-attachment
        // messages whose segments.text may be empty (e.g. a bare slash command with
        // no trailing text, where the entire content is consumed as a marker).
        if message.role == .user || message.role == .assistant {
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                let strippedText = parseAttachmentSegments(message.content).text
                let preview = strippedText.isEmpty ? message.content : strippedText
                tabs[idx].lastMessage = String(preview.prefix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
        }
        // Defect A fix: render the live user/assistant echo even on a fresh
        // conversation that has not been loaded yet. The desktop forwards a
        // user echo as a desktop_message_added (role == .user) from its own
        // remote-prompt path (remote/handlers/tabs-prompt.ts); on an iOS-started
        // slash command for a fresh extension-hosted conversation, no history
        // had loaded yet, so the `conversationLoaded` guard dropped that echo
        // and NO user bubble rendered. For user/assistant roles we now mark the
        // conversation loaded and fall through to the insert/reconcile-by-id
        // block below. A later full history reload (handleConversationHistory)
        // replaces the list and reconciles by id, so this early insert never
        // produces a duplicate. Other roles (tool/system) keep the original
        // guard — they are only meaningful against an already-loaded
        // conversation.
        if message.role == .user || message.role == .assistant {
            if !conversationLoaded.contains(tabId) {
                DiagnosticLog.log("message added echo on unloaded conversation", tag: "session.msg", fields: [
                    "tab_id": String(tabId.prefix(8)),
                    "reason": message.role.rawValue
                ])
                conversationLoaded.insert(tabId)
            }
        } else {
            guard conversationLoaded.contains(tabId) else { return }
        }
        mutateConversationMessages(tabId: tabId) { msgs in
            // ID-based reconciliation: if a message with this ID already exists
            // (optimistic insert), replace it with the canonical version from desktop.
            if let existingIdx = msgs.firstIndex(where: { $0.id == message.id }) {
                DiagnosticLog.log("message reconciled", tag: "session.msg", fields: [
                    "tab_id": String(tabId.prefix(8)),
                    "reason": String(message.id.prefix(8)),
                    "status": message.role.rawValue,
                    "count": String(msgs.count)
                ])
                msgs[existingIdx] = message
            } else {
                DiagnosticLog.log("message appended", tag: "session.msg", fields: [
                    "tab_id": String(tabId.prefix(8)),
                    "reason": String(message.id.prefix(8)),
                    "status": message.role.rawValue,
                    "count": String(msgs.count + 1)
                ])
                msgs.append(message)
            }
        }
    }

    @MainActor
    func handleMessageUpdated(tabId: String, messageId: String, content: String?, toolStatus: ToolStatus?, toolInput: String?) {
        guard conversationLoaded.contains(tabId) else { return }
        mutateConversationMessages(tabId: tabId) { msgs in
            guard let idx = msgs.firstIndex(where: { $0.id == messageId }) else { return }
            if let content {
                msgs[idx].content = content
            }
            if let toolStatus {
                // Meta-tools report as errors but should show as completed (not error, not stuck running)
                let toolName = msgs[idx].toolName
                if toolName == "ExitPlanMode" || toolName == "AskUserQuestion" {
                    msgs[idx].toolStatus = .completed
                } else {
                    msgs[idx].toolStatus = toolStatus
                }
            }
            if let toolInput {
                msgs[idx].toolInput = toolInput
            }
        }
    }

    @MainActor
    func handleInputPrefill(tabId: String, text: String, switchTo: Bool, instanceId: String?) {
        // Engine-instance prefill (engine_rewind): seed the engine instance's
        // draft, not the CLI input. The desktop broadcasts a fresh
        // desktop_conversation_history immediately after the rewind restart
        // (broadcastEngineHistory), which the conversationHistory handler
        // applies as a full replace — so the truncated message list refreshes
        // on its own. Here we only place the rewound user message back in the
        // engine input box.
        if let instanceId {
            DiagnosticLog.log("input prefill to engine draft", tag: "session.prefill", fields: [
                "tab_id": String(tabId.prefix(8)),
                "reason": String(instanceId.prefix(8)),
                "count": String(text.count)
            ])
            setEngineDraft(tabId: tabId, instanceId: instanceId, text)
            if switchTo {
                pendingNavigationTabId = tabId
            }
            return
        }

        // CLI-tab prefill: write the tab-level pending input and (for a
        // rewind, switchTo == false) reload the CLI conversation so the
        // truncated history is reflected.
        pendingInputByTab[tabId] = text
        if switchTo {
            pendingNavigationTabId = tabId
        } else {
            // Rewind: reload the conversation for this tab
            conversationLoaded.remove(tabId)
            setConversationMessages(tabId: tabId, [])
            conversationLoadFailed.remove(tabId)
            loadConversation(tabId: tabId)
        }
    }
}
