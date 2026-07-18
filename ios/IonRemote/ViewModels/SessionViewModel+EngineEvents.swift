import Foundation

// MARK: - Engine Event Handlers

extension SessionViewModel {

    @MainActor
    func handleEngineIntercept(tabId: String, instanceId: String?, level: String, title: String, message: String) {
        // Render the intercept inline in the engine conversation scrollback
        // so the user can see that an extension fired an intercept, what it
        // said, and whether the run was redirected. Uses role: .harness so
        // EngineMessageRow routes it through the intercept banner style.
        // `interceptLevel` on the Message lets the view choose visual weight:
        //   "redirect" — amber/urgent (run was aborted + re-prompted by desktop)
        //   "banner"   — lighter informational style
        //
        // Content format mirrors the desktop: bold title line prefixed with
        // "Conversation redirected: " for redirect level, then the body.
        DiagnosticLog.log("engine intercept", tag: "session.engine", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": level,
            "status": String(title.prefix(60))
        ])
        let levelPrefix = level == "redirect" ? "Conversation redirected: " : ""
        let content = "**\(levelPrefix)\(title)**\n\n\(message)"
        var msg = Message(
            id: UUID().uuidString,
            role: .harness,
            content: content,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        msg.interceptLevel = level
        // RC-11: live event — stamp isLive so a first-page history replace
        // preserves this row in the live tail rather than dropping it.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
    }

    @MainActor
    func handleEngineHarnessMessage(tabId: String, instanceId: String?, message: String, dedupKey: String?, dedupMode: String?) {
        // Divider messages (session-start, implement, etc.) use the `──` sentinel
        // prefix and render as system-role messages for the divider visual treatment.
        let role: MessageRole = message.hasPrefix("──") ? .system : .harness
        var msg = Message(id: UUID().uuidString, role: role, content: message, timestamp: Date().timeIntervalSince1970 * 1000)
        msg.dedupKey = dedupKey
        msg.dedupMode = dedupMode
        // RC-11: harness messages arrive during a live run; stamp isLive before
        // the closure so all three append paths inside inherit the flag.
        msg.isLive = true

        DiagnosticLog.log("engine harness message", tag: "session.engine", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "dedup_key": dedupKey ?? "(none)",
            "dedup_mode": dedupMode ?? "(none)"
        ])

        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if dedupMode == "relocate", let dk = dedupKey, !dk.isEmpty {
                // Relocate: remove any existing message with this key, append the
                // new one at the end. The marker always stays current — never
                // trails behind new conversation turns.
                inst.messages = inst.messages.filter { $0.dedupKey != dk }
                inst.messages.append(msg)
            } else if let dk = dedupKey, !dk.isEmpty {
                // Suppress-later: if a message with the same dedupKey already
                // exists, drop this one. Default dedup behavior.
                let alreadyPresent = inst.messages.contains { $0.dedupKey == dk }
                if !alreadyPresent {
                    inst.messages.append(msg)
                }
            } else {
                // No dedupKey: append unconditionally.
                inst.messages.append(msg)
            }
        }
    }

    @MainActor
    func handleEnginePlanModeChanged(tabId: String, instanceId: String?, planModeEnabled: Bool, planFilePath: String?, planSlug: String?) {
        // Plan-mode ENTRY no longer draws a divider. Entry happens before the
        // model has written the plan file, so a marker here would be
        // mispositioned (before any narrative) and its link would not resolve
        // (the file does not exist yet). The divider is now driven by
        // engine_plan_file_written (the actual write) — see
        // handleEnginePlanFileWritten. iOS keeps no plan-mode state of its own
        // here today, so this is an observe-only no-op; the guard documents the
        // proposal (enabled=false) case explicitly.
        guard planModeEnabled else { return }
        _ = (planFilePath, planSlug, instanceId, tabId)
    }

    @MainActor
    func handleEnginePlanFileWritten(tabId: String, instanceId: String?, operation: String, planFilePath: String?, planSlug: String?) {
        // The engine confirmed a Write/Edit landed on the canonical plan file.
        // This is the accurate point to insert the plan-lifecycle divider: the
        // file now exists with content, so the marker is correctly positioned
        // (right after the model's narrative + the write) and the slug link
        // resolves. The engine carries the created-vs-updated discriminator
        // (operation) because only it can observe the file's prior state.
        let slug = planSlug ?? ""
        let time = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeStr = formatter.string(from: time)
        let label = operation == "updated" ? "Plan updated" : "Plan created"
        let content = slug.isEmpty
            ? "── \(label) at \(timeStr) ──"
            : "── \(label) at \(timeStr) · \(slug) ──"
        var msg = Message(id: UUID().uuidString, role: .system, content: content, timestamp: time.timeIntervalSince1970 * 1000)
        // Carry the plan path so the divider row can make the slug a tappable
        // link that opens the plan preview. Empty path stays nil (no link).
        let path = planFilePath ?? ""
        msg.planFilePath = path.isEmpty ? nil : path
        // RC-11: plan-file divider is emitted during a live run; preserve in tail.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
    }

    @MainActor
    func handleEngineSteerInjected(tabId: String, instanceId: String?, messageLength: Int) {
        // Engine drained a mid-turn steer into the conversation. Mirror
        // the desktop's "Steer applied" divider so the user sees
        // confirmation across both clients. messageLength is included so
        // the user can tell a short nudge from a long steer at a glance.
        // The engine may emit this multiple times per turn (between
        // turns, before end_turn exit, after tool results); each capture
        // produces its own divider so the count is visible.
        let time = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeStr = formatter.string(from: time)
        let content = "── Steer applied at \(timeStr) · \(messageLength) chars ──"
        var msg = Message(id: UUID().uuidString, role: .system, content: content, timestamp: time.timeIntervalSince1970 * 1000)
        // RC-11: steer dividers appear mid-run; preserve in the live tail.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
    }

    @MainActor
    func handleEnginePromptInjected(tabId: String, instanceId: String?, prompt: String) {
        // Extension-injected prompt (engine ctx.sendPrompt): no client
        // submitted this turn, so no optimistic insert happened anywhere.
        // Append it as the user turn it is — the same content persists in
        // the conversation file, so a history reload shows the identical
        // transcript. Mirrors the desktop's prompt_injected reducer arm.
        var msg = Message(id: UUID().uuidString, role: .user, content: prompt, timestamp: Date().timeIntervalSince1970 * 1000)
        // RC-11: extension-injected prompts start a live run; preserve in tail.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
    }

    @MainActor
    func handleEngineToolStart(tabId: String, instanceId: String?, toolName: String, toolId: String) {
        DiagnosticLog.log("engine tool start", tag: "session.engine", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "tool": toolName,
            "reason": String(toolId.prefix(8))
        ])
        let info = ActiveToolInfo(id: toolId, toolName: toolName, startTime: Date())
        activeTools[tabId, default: [:]][toolId] = info
        // Add tool message to conversation — RC-22: guard against a duplicate
        // tool_start (reconnect replay, engine re-emit). The row id IS the toolId,
        // so a second append creates a duplicate SwiftUI Identifiable id, breaking
        // ForEach identity (dropped/flickering rows) and leaving tool_end's
        // lastIndex update to touch only one. If a row for this toolId already
        // exists, refresh it in place instead of appending.
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let idx = inst.messages.lastIndex(where: { $0.toolId == toolId }) {
                inst.messages[idx].toolName = toolName
                inst.messages[idx].toolStatus = .running
                return
            }
            var msg = Message(id: toolId, role: .tool, content: "", toolName: toolName, toolId: toolId, toolStatus: .running, timestamp: Date().timeIntervalSince1970 * 1000)
            msg.isLive = true // RC-11: tool rows are part of the live tail
            inst.messages.append(msg)
        }
    }

    @MainActor
    func handleEngineToolEnd(tabId: String, instanceId: String?, toolId: String, result: String?, isError: Bool) {
        DiagnosticLog.log("engine tool end", tag: "session.engine", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": String(toolId.prefix(8)),
            "status": String(isError)
        ])
        activeTools[tabId]?[toolId] = nil
        if activeTools[tabId]?.isEmpty == true {
            activeTools.removeValue(forKey: tabId)
        }
        // Update tool message status in conversation
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let idx = inst.messages.lastIndex(where: { $0.toolId == toolId }) {
                inst.messages[idx].toolStatus = isError ? .error : .completed
                if let result { inst.messages[idx].content = result }
            }
        }
    }

    @MainActor
    func handleEngineImageContent(tabId: String, instanceId: String?, path: String, mediaType: String, source: String, toolId: String?) {
        DiagnosticLog.log("engine image content", tag: "session.engine", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": source,
            "status": (path as NSString).lastPathComponent
        ])
        // The engine forwards the FILE PATH (never base64). Attach it to the
        // owning message so EngineMessageRow renders it via InlineAttachmentImage,
        // which fetches bytes lazily through RemoteImageFetcher on a cache miss.
        // Mirrors the desktop attachImageToMessages reducer (event-slice-images.ts):
        //   - source "tool" (toolId set): attach to the matching tool message.
        //   - source "provider" (or no toolId): attach to the last assistant
        //     message, creating an empty one if the run produced none yet.
        let attachment = MessageAttachment(
            id: "img:\(path)",
            type: .image,
            name: (path as NSString).lastPathComponent,
            path: path
        )
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            // RC-25: dedup by scanning ALL messages for the path, not just the
            // target row. Between two image events for the same path the "last
            // assistant" row can shift (a message_end re-key, or a new assistant
            // row opening), so a per-row check let the same image attach to a
            // second bubble. A whole-instance scan makes the attach idempotent.
            func attachedAnywhere() -> Bool {
                inst.messages.contains { $0.attachments?.contains(where: { $0.path == path }) ?? false }
            }
            if attachedAnywhere() { return }
            if source == "tool", let toolId {
                guard let idx = inst.messages.lastIndex(where: { $0.toolId == toolId }) else { return }
                inst.messages[idx].attachments = (inst.messages[idx].attachments ?? []) + [attachment]
                return
            }
            if let idx = inst.messages.lastIndex(where: { $0.role == .assistant }) {
                inst.messages[idx].attachments = (inst.messages[idx].attachments ?? []) + [attachment]
                return
            }
            let msg = Message(
                id: UUID().uuidString,
                role: .assistant,
                content: "",
                attachments: [attachment],
                timestamp: Date().timeIntervalSince1970 * 1000
            )
            // RC-11: this fallback assistant row is created during a live run;
            // stamp isLive directly (inside the closure, appendLiveMessage
            // can't be called here).
            var liveMsg = msg
            liveMsg.isLive = true
            inst.messages.append(liveMsg)
        }
    }

    @MainActor
    func handleEngineError(tabId: String, instanceId: String?, message: String) {
        DiagnosticLog.log("engine error", tag: "session.engine", level: .error, fields: [
            "tab_id": String(tabId.prefix(8)),
            "error": String(message.prefix(80))
        ])
        // Add error as system message in conversation
        var msg = Message(id: UUID().uuidString, role: .system, content: "Error: \(message)", timestamp: Date().timeIntervalSince1970 * 1000)
        // RC-11: engine errors surface during a live run; preserve in tail.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
        // Reset tab to idle so user can retry
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .idle
        }
    }

    @MainActor
    func handleEngineNotify(tabId: String, instanceId: String?, message: String, level: String?) {
        DiagnosticLog.log("engine notify", tag: "session.engine", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": level ?? "info",
            "status": String(message.prefix(60))
        ])
        // Surface notifications as system messages in the conversation
        let prefix = level == "warning" ? "⚠️ " : level == "error" ? "❌ " : ""
        var msg = Message(id: UUID().uuidString, role: .system, content: "\(prefix)\(message)", timestamp: Date().timeIntervalSince1970 * 1000)
        // RC-11: notify events arrive during a live run; preserve in tail.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
    }

    @MainActor
    func handleEngineTextDelta(tabId: String, instanceId: String?, text: String) {
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let last = inst.messages.last, last.role == .assistant, !last.sealed {
                // Append to the LIVE assistant row (last row, assistant, NOT
                // sealed). This is the in-progress row of the current run.
                inst.messages[inst.messages.count - 1].content += text
            } else {
                // The last row is a non-assistant row (tool/system), the list is
                // empty, OR the last assistant row is SEALED. A sealed assistant
                // row was finalized by engine_message_end and (when entryId was
                // present) re-keyed to its canonical persisted id. RC-12: a late
                // delta must NOT reopen it — appending would mutate a canonical
                // row's content/byte-length so the staleness fingerprint diverges
                // from the desktop permanently, driving maybeReconcileStaleConversation
                // into a 4s reload loop (flicker + corrupted text), and could let
                // the message_end re-key walk-back land on the wrong unsealed row
                // (identity steal). Open a FRESH live row instead — the late delta
                // belongs to the next message of the run, or is a stray the fresh
                // row harmlessly isolates.
                var fresh = Message(id: UUID().uuidString, role: .assistant, content: text, timestamp: Date().timeIntervalSince1970 * 1000)
                fresh.isLive = true // RC-11: live tail boundary
                inst.messages.append(fresh)
            }
        }
        engineTurnHasText.insert(tabId)
        // Set tab running if this is the active instance
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .running
        }
    }

    /// desktop_stream_reset: the engine discarded the current attempt's
    /// partial output (mid-stream provider retry or reactive compaction) and
    /// is re-streaming the turn. Mirror the desktop renderer's stream_reset
    /// handling: drop the trailing in-progress assistant text row and any
    /// ACTIVE thinking row (a sealed thinking row from earlier in the turn
    /// survives). The re-streamed attempt arrives as fresh text deltas.
    @MainActor
    func handleEngineStreamReset(tabId: String, instanceId: String?) {
        DiagnosticLog.log("stream reset: discarding partial attempt output", tag: "session.engine", level: .info, fields: [
            "tab_id": String(tabId.prefix(8))
        ])
        // Remove the active thinking row before touching the assistant text —
        // the live row (if any) is the last thinking message by id.
        if let msgId = thinkingMessageId(tabId) {
            setThinkingMessageId(tabId: tabId, nil)
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
                if let idx = inst.messages.lastIndex(where: { $0.id == msgId }) {
                    inst.messages.remove(at: idx)
                }
            }
        }
        // Discard the trailing in-progress assistant text row (never a tool row).
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let last = inst.messages.last, last.role == .assistant, last.toolName == nil {
                inst.messages.removeLast()
            }
        }
        engineTurnHasText.remove(tabId)
    }

    @MainActor
    func handleEngineMessageEnd(tabId: String, instanceId: String?, inputTokens: Int?, contextPercent: Double?, entryId: String? = nil, userEntryId: String? = nil) {
        // Clear pinned prompt after message completes
        enginePinnedPrompt[tabId] = nil
        // Update context stats only — do NOT set status to .idle here.
        // The agent may continue with tool calls after a message ends.
        // Tab status transitions to idle only via authoritative events:
        // tabStatus, taskComplete, engineDead, or snapshot reconciliation.
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].contextTokens = inputTokens
            tabs[idx].contextPercent = contextPercent
        }

        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            // RE-KEY the streamed rows to their canonical persisted tree-entry
            // ids so a subsequent history page — which keys its rows by those
            // ids — anchors on them instead of duplicating them.
            //
            // Assistant row: walk back from the end past tool/thinking/system
            // rows (a user row is a turn boundary — stop) to the most recent
            // assistant text row. Only an UNSEALED row is re-keyed and then
            // sealed: a tool-only assistant message's end (no text row of its
            // own) walks back to the PREVIOUS message's row, and re-keying
            // that already-sealed row would steal its identity.
            if let entryId {
                var i = inst.messages.count - 1
                while i >= 0 {
                    let role = inst.messages[i].role
                    if role == .assistant || role == .user { break }
                    i -= 1
                }
                if i >= 0, inst.messages[i].role == .assistant,
                   inst.messages[i].toolName == nil, !inst.messages[i].sealed {
                    if inst.messages[i].id != entryId {
                        inst.messages[i].id = entryId
                    }
                    // Seal at the re-key site (not only on the trailing row):
                    // when tool rows follow the text, the trailing-row seal
                    // below misses this row and the NEXT tool-only message_end
                    // would re-key it. Sealing here makes the protection
                    // self-sustaining.
                    inst.messages[i].sealed = true
                }
            }
            // User row: the run-opening user turn (optimistic clientMsgId or
            // prompt-injected UUID) adopts its canonical persisted id.
            if let userEntryId,
               let uIdx = inst.messages.lastIndex(where: { $0.role == .user }),
               inst.messages[uIdx].id != userEntryId {
                inst.messages[uIdx].id = userEntryId
            }
            // Seal the last assistant message so the next text delta starts fresh.
            if let lastIdx = inst.messages.indices.last, inst.messages[lastIdx].role == .assistant {
                inst.messages[lastIdx].sealed = true
            }
        }

        engineTurnHasText.remove(tabId)
    }

    /// Re-key the run-opening optimistic user row to its canonical persisted
    /// tree-entry id the moment the engine persists the turn (before
    /// streaming). This is the run-outcome-independent half of the
    /// message_end userEntryId re-key above: a run cancelled or failed
    /// mid-stream never reaches a message_end, so without this event the
    /// optimistic row keeps its clientMsgId and the next history page —
    /// keyed by canonical ids — cannot anchor on it, rendering the user
    /// turn twice (once from history, once as the stale optimistic row).
    @MainActor
    func handleEngineUserTurnPersisted(tabId: String, instanceId: String?, entryId: String) {
        guard !entryId.isEmpty else { return }
        DiagnosticLog.log("user turn persisted", tag: "session.msg", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": String(entryId.prefix(8))
        ])
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let uIdx = inst.messages.lastIndex(where: { $0.role == .user }),
               inst.messages[uIdx].id != entryId {
                inst.messages[uIdx].id = entryId
            }
        }
    }

    @MainActor
    func handleEngineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String]) {
        DiagnosticLog.log("engine dead", tag: "session.engine", level: .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "status": String(exitCode ?? -1),
            "reason": signal ?? "nil"
        ])
        // exitCode 0/nil = normal exit or idle cleanup, not a real death
        guard let exitCode, exitCode != 0 else { return }
        // Only mark tab dead if no other instances are running
        let instId = instanceId
        let others = conversationInstances[tabId]?.filter { $0.id != instId } ?? []
        if others.isEmpty {
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].status = .dead
            }
        }
        // Add a system message about the death
        var deathMsg = "Engine process died (exit code \(exitCode))"
        if let signal { deathMsg += ", signal: \(signal)" }
        if !stderrTail.isEmpty { deathMsg += "\n" + stderrTail.suffix(5).joined(separator: "\n") }
        let msg = Message(id: UUID().uuidString, role: .system, content: deathMsg, timestamp: Date().timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    // handleEngineInstanceRemoved was removed in #256 (single-instance collapse).
    // The engine_instance_added/removed/moved events are still emitted by the
    // desktop but iOS drops them in handleEvent — the snapshot is the
    // authoritative source of instance truth. Per-tab conversation state
    // (messages, liveText, workingMessage, thinkingMessageId) lives on the
    // single ConversationInstanceInfo and is dropped wholesale when the tab
    // closes — no per-map cleanup is needed.
}
