import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Snapshot Handling

extension SessionViewModel {

    @MainActor
    func handleSnapshot(snapshotTabs: [RemoteTabState], recentDirs: [String], groupMode: String?, groups: [RemoteTabGroup]?, preferredModel: String? = nil, engineDefaultModel: String? = nil, availableModels: [RemoteModelEntry]? = nil) {
        DiagnosticLog.log("SNAP: received tabs=\(snapshotTabs.count) dirs=\(recentDirs.count) groupMode=\(groupMode ?? "nil") models=\(availableModels?.count ?? 0)")
        // Log any tabs that arrive with a non-empty permission queue so we can
        // confirm the blue dot has the data it needs at relaunch.
        for t in snapshotTabs where !t.permissionQueue.isEmpty {
            let tools = t.permissionQueue.map { "\($0.toolName)(id=\($0.questionId.prefix(12)))" }.joined(separator: ", ")
            DiagnosticLog.log("SNAP: tab=\(t.id.prefix(8)) status=\(t.status.rawValue) queue=[\(tools)]")
        }
        for t in snapshotTabs where t.hasEngineExtension == true && t.permissionQueue.isEmpty {
            if t.status == .completed || t.status == .idle {
                DiagnosticLog.log("SNAP: engine tab=\(t.id.prefix(8)) status=\(t.status.rawValue) queue=EMPTY (no denials promoted)")
            }
        }
        if connectionState != .connected {
            DiagnosticLog.log("SNAP: connected (was \(connectionState))")
            connectionState = .connected
            cancelReconnectSafetyTimer()
            // The transport is now proven usable (we just got a real
            // snapshot back from the desktop), so release any commands
            // that were deferred via `runWhenConnected` during the
            // reconnect window — e.g. the scene-resume git refresh and
            // focus report. Order matters: we flip state first so that
            // a drained block which re-checks `connectionState` (or
            // calls `runWhenConnected` again) sees `.connected` and
            // runs inline rather than re-queueing.
            drainPendingOnConnected()
            drainPendingEssential()
        }
        connectionQuality.transportState = transport?.state ?? .disconnected
        if !recentDirs.isEmpty {
            recentDirectories = recentDirs
        }
        // Update tab group mode and groups from desktop
        if let mode = groupMode {
            tabGroupMode = mode
        }
        if let grps = groups {
            tabGroups = grps
        }
        if let pm = preferredModel {
            self.preferredModel = pm
        }
        if let edm = engineDefaultModel {
            self.engineDefaultModel = edm
        }
        if let models = availableModels, !models.isEmpty {
            self.availableModels = models
        }
        // Filter out tabs that iOS requested to close but hasn't received
        // tab_closed confirmation for yet. Without this, the snapshot
        // resurrects tabs that the user just swiped away.
        let filteredTabs = snapshotTabs.filter { !pendingCloseTabIds.contains($0.id) }
        // Preserve locally-injected permission queue entries that arrived
        // via permission_request events. Snapshots pull the queue from the
        // desktop renderer, which may have already auto-allowed tools like
        // AskUserQuestion/ExitPlanMode (empty queue), while iOS still needs
        // to show the card until the user taps an answer.
        var merged = filteredTabs
        for i in merged.indices {
            let tabId = merged[i].id

            // Strip ExitPlanMode/AskUserQuestion entries from the snapshot
            // queue if the user already dismissed the card on this tab.
            // The 5-second snapshot polling can re-inject stale entries
            // from the desktop's permissionDenied before it's cleared.
            //
            // Dismissals come in two scopes (see dismissSpecialPermission):
            //   - bare tabId — CLI tabs and legacy entries without
            //     instance identity; strips every special entry on the tab.
            //   - "tabId:instanceId" — engine sub-tab dismissals; strips
            //     only entries owned by that instance so a sibling
            //     sub-tab's pending card survives the sweep.
            //
            // Belt-and-suspenders for the stale-promotion bug: a snapshot
            // entry whose questionId is prefixed "denied-" is a residue of
            // permissionDenied promotion. When the tab is running or connecting
            // the run has already resumed — the card must not render. Strip
            // it here so a stale promotion from the desktop (before it clears
            // permissionDenied) never shows on a running tab.
            let isRunningOrConnecting = merged[i].status == .running || merged[i].status == .connecting
            let tabStatus = merged[i].status.rawValue
            let tabIdPrefix = String(merged[i].id.prefix(8))
            merged[i].permissionQueue.removeAll { entry in
                guard entry.toolName == "ExitPlanMode" || entry.toolName == "AskUserQuestion" else {
                    return false
                }
                // Stale promoted denial on a running/connecting tab — strip it.
                if isRunningOrConnecting && entry.questionId.hasPrefix("denied-") {
                    DiagnosticLog.log("SNAP: stripped stale denied-* entry tabId=\(tabIdPrefix) status=\(tabStatus) tool=\(entry.toolName) qid=\(entry.questionId.prefix(16))")
                    return true
                }
                if dismissedLiveSpecialTabs.contains(tabId) { return true }
                if let instanceId = entry.instanceId,
                   dismissedLiveSpecialTabs.contains("\(tabId):\(instanceId)") {
                    return true
                }
                return false
            }

            if let existing = tabs.first(where: { $0.id == tabId }),
               !existing.permissionQueue.isEmpty {
                // Keep existing local queue entries that aren't in the snapshot
                let snapshotIds = Set(merged[i].permissionQueue.map(\.questionId))
                let isRunning = merged[i].status == .running
                let localOnly = existing.permissionQueue.filter { entry in
                    if snapshotIds.contains(entry.questionId) { return false }
                    // Don't re-inject stale plan/question cards once a new task is running
                    if isRunning && (entry.toolName == "ExitPlanMode" || entry.toolName == "AskUserQuestion") {
                        return false
                    }
                    return true
                }
                merged[i].permissionQueue.append(contentsOf: localOnly)
                // Note: the snapshot now carries planContentPreview (first 4 KB)
                // for ExitPlanMode entries, so there's no longer a need to prefer
                // local entries for planContent enrichment. Snapshot entries are
                // always usable for plan card rendering.
            }
        }
        // Always prefer locally-tracked lastMessage over snapshot values.
        // Real-time textChunk/messageAdded events update lastMessage on iOS
        // faster than the 5-second snapshot poll, so the local value is
        // always equal or fresher. The snapshot value is only used for
        // initial population (when no local value exists yet).
        for i in merged.indices {
            if let existing = tabs.first(where: { $0.id == merged[i].id }),
               existing.lastMessage != nil {
                merged[i].lastMessage = existing.lastMessage
            }
        }
        tabs = merged
        tabIds = Set(merged.map(\.id))
        // Reconcile idle-since timestamps with snapshot state
        let mergedIds = Set(merged.map(\.id))
        for tab in merged {
            if tab.status == .running || tab.status == .connecting {
                tabIdleSince.removeValue(forKey: tab.id)
            } else if tabIdleSince[tab.id] == nil {
                // Prefer the desktop-provided activity timestamp over local Date()
                if let ms = tab.lastActivityAt, ms > 0 {
                    tabIdleSince[tab.id] = Date(timeIntervalSince1970: ms / 1000.0)
                } else {
                    tabIdleSince[tab.id] = Date()
                }
            }
        }
        // Clean up idle-since entries for tabs no longer present
        for tabId in tabIdleSince.keys where !mergedIds.contains(tabId) {
            tabIdleSince.removeValue(forKey: tabId)
        }
        // Clean up drafts for tabs no longer present in the snapshot
        // (tab was closed remotely; drafts are scoped to live tabs). Post-#256
        // there is one bare-tabId-keyed draft store for both plain and engine
        // tabs, so a single sweep covers both.
        for tabId in draftInputByTab.keys where !mergedIds.contains(tabId) {
            clearTabDraft(tabId)
        }
        // Populate terminal state from snapshot tab data
        for tab in merged {
            if tab.isTerminalOnly == true, let instances = tab.terminalInstances {
                terminalInstances[tab.id] = instances
                activeTerminalInstance[tab.id] = tab.activeTerminalInstanceId ?? instances.first?.id
            }
            // Populate conversation instance state from snapshot tab data.
            //
            // #256 follow-up: this is DATA-driven, NOT tab-type-gated. The
            // former `tab.hasEngineExtension == true` guard was an illegitimate
            // type fork — a plain conversation that dispatches background
            // sub-agents ALSO has `conversationInstances` carrying
            // `agentStates` / `runningAgentCount`, and must get them merged so
            // its agent panel and status surfaces render. We gate purely on the
            // presence of instances in the snapshot ("has data"), so plain and
            // extension-backed tabs flow through the identical path; the only
            // difference is the data (a plain tab simply tends to carry an
            // empty agents list / no harness name).
            if let instances = tab.conversationInstances, !instances.isEmpty {
                // Ensure a target instance exists before the merge so runtime
                // state has something to land on even on the very first
                // snapshot for a not-yet-touched tab (plain or engine). Without
                // this, a plain tab's first snapshot would have no `existing`
                // entry and the merge below would fall through to the
                // snapshot-as-is branch — correct, but `ensureMainInstance`
                // additionally primes `activeEngineInstance` so the view's
                // accessors resolve the instance without waiting for the
                // resolver assignment below.
                ensureMainInstance(tabId: tab.id)
                // Merge snapshot-projected fields onto existing instances so
                // we preserve runtime conversation state across snapshot
                // ticks. ConversationInstanceInfo carries two flavors of state:
                //
                //   - Snapshot-projected (Codable): id, label, waitingState,
                //     isRunning, runningAgentCount, modelFallback. These are
                //     authoritative from the desktop snapshot every tick.
                //   - Runtime-only (excluded from Codable): messages,
                //     agentStates, statusFields, modelOverride. These are
                //     populated by live events / loadConversation and
                //     must survive the snapshot reassignment.
                //
                // Previously this code did `conversationInstances[tab.id] =
                // instances.map { ConversationInstanceInfo(id:label:waitingState:) }`
                // which constructed fresh instances with default-empty
                // runtime state — wiping messages every snapshot. That was
                // masked by an unconditional `loadConversation` call
                // below that immediately refetched the history (and caused
                // the every-5s flicker). With the guard in place, the wipe
                // is no longer masked and the conversation would disappear
                // a few seconds after open. The merge below fixes the root
                // cause: preserve runtime state, update snapshot fields.
                let existing = conversationInstances[tab.id] ?? []
                conversationInstances[tab.id] = instances.map { snap in
                    if var prior = existing.first(where: { $0.id == snap.id }) {
                        prior.label = snap.label
                        prior.waitingState = snap.waitingState
                        prior.isRunning = snap.isRunning
                        prior.runningAgentCount = snap.runningAgentCount
                        prior.modelFallback = snap.modelFallback
                        // thinkingEffort is snapshot-projected (desktop sends it
                        // from the active instance). Update it every tick so a
                        // change made on the desktop side (or by a remote client)
                        // is reflected here. The optimistic write in
                        // setThinkingEffort also lands here (WI-002 / #259), so
                        // the snapshot is the authoritative settle path.
                        prior.thinkingEffort = snap.thinkingEffort
                        return prior
                    }
                    // New instance not seen before — use the snapshot value
                    // as-is; runtime fields default to their empty values
                    // and will be populated by loadConversation /
                    // live events.
                    return snap
                }
                activeEngineInstance[tab.id] = ConversationInstanceInfo.resolveActiveInstanceId(
                    activeId: tab.activeConversationInstanceId,
                    instances: instances
                )
                ionLog.info("snapshot: conversation tab \(tab.id.prefix(8)), instances=\(instances.map(\.id)), active=\(tab.activeConversationInstanceId ?? "nil")")
                // Pre-load conversation history for tabs we haven't loaded yet.
                // Guarded against `conversationLoaded` so the snapshot handler —
                // which runs on every ~5s snapshot delivery — does not re-issue
                // a load command for tabs that already have history.
                //
                // WI-004 / #259: loadConversation handles every tab. The former
                // engine-only fork (loadEngineConversation for hasEngineExtension
                // tabs) is retired: with WI-001/WI-002 landed, all messages live
                // on the active instance regardless of backend.
                if !conversationLoaded.contains(tab.id) {
                    // A tab that already holds live-streamed messages (from wire
                    // deltas) but was never explicitly history-loaded must NOT be
                    // wiped by the pre-load: loadConversation clears the transcript
                    // before re-fetching, which would flicker (or, with no
                    // transport, drop) the live messages. Treat "has local
                    // messages" as effectively loaded — mark it so and skip the
                    // destructive pre-load. A genuinely-empty tab still pre-loads.
                    if !conversationMessages(tab.id).isEmpty {
                        DiagnosticLog.log("SNAP: conv has live messages tabId=\(tab.id.prefix(16)) — marking loaded, skipping pre-load")
                        conversationLoaded.insert(tab.id)
                        maybeReconcileStaleConversation(tab: tab)
                    } else {
                        DiagnosticLog.log("SNAP: conv not loaded for tabId=\(tab.id.prefix(16)) — firing loadConversation")
                        loadConversation(tabId: tab.id)
                    }
                } else {
                    DiagnosticLog.log("SNAP: conv already loaded tabId=\(tab.id.prefix(16)) — skipping")
                    // Staleness reconcile: the main conversation is filled only by
                    // live wire deltas after the initial load. If deltas were
                    // dropped (e.g. a LAN↔relay transport switch or a seq gap mid
                    // stream), the local transcript silently freezes while the
                    // desktop keeps streaming. The snapshot does not carry the
                    // messages themselves, but it DOES carry the desktop's
                    // authoritative last-activity timestamp (lastActivityAt). When
                    // that is newer than our newest local message, we are missing
                    // newer messages — re-fetch the authoritative history to heal.
                    // Timestamp comparison is pagination-safe (unlike a raw count,
                    // which iOS caps at the page size).
                    maybeReconcileStaleConversation(tab: tab)
                }
            }
        }
        // Re-send in-flight conversation loads that may have been dropped.
        for tabId in loadingConversation {
            send(.loadConversation(tabId: tabId, before: conversationCursor[tabId]), intent: .automaticEssential)
        }

        // Cache layout for the active device so reconnects restore it.
        if let deviceId = activeDevice?.id {
            if !hasConnectedBefore {
                hasConnectedBefore = true
                UserDefaults.standard.set(true, forKey: "hasConnectedBefore")
            }
            LayoutCache.save(
                deviceId: deviceId,
                tabs: merged,
                tabGroupMode: tabGroupMode,
                tabGroups: tabGroups,
                recentDirectories: recentDirectories
            )
        }

        // Send voice configuration so the desktop knows current voice settings.
        sendVoiceConfig()
    }

    /// Minimum interval between staleness reconciles for a single tab. A live
    /// run streams deltas frequently; the local tail can briefly differ from the
    /// desktop's by the in-flight deltas. The debounce ensures we only heal when
    /// the divergence persists across the snapshot cadence (a genuine drop), not
    /// on a transient mid-stream lag.
    private static let reconcileDebounce: TimeInterval = 4

    /// Number of trailing messages the staleness fingerprint spans. MUST match
    /// the desktop's FINGERPRINT_TAIL_WINDOW (shared/conversation-fingerprint.ts
    /// and the snapshot.ts inline JS). Smaller than the history page size so
    /// pagination never causes divergence.
    private static let fingerprintTailWindow = 10

    /// Compute the conversation tail fingerprint over `messages`. This MUST be
    /// byte-identical with the desktop (shared/conversation-fingerprint.ts and
    /// the snapshot.ts inline JS) for the same input, or every snapshot would
    /// false-positive into a reload loop. Pinning rules:
    ///   - window: the last `fingerprintTailWindow` messages, in order;
    ///   - tool rows: "<id>:t<statusChar>" (status only — truncation-immune,
    ///     because the history page truncates tool content >2KB while the
    ///     snapshot sees the full content);
    ///   - non-tool rows: "<id>:<utf8ByteLen>" (utf8.count, never UTF-16 count);
    ///   - tokens joined with ",". NO total-count term: iOS holds a paginated
    ///     PAGE (local count = page size) while the desktop holds the FULL list,
    ///     so any count term diverges on long conversations and reload-loops.
    /// The golden parity anchor is pinned in ConversationStalenessReconcileTests
    /// and conversation-fingerprint.test.ts (same input → same string).
    @MainActor
    func conversationTailFingerprint(_ messages: [Message]) -> String {
        let start = max(0, messages.count - Self.fingerprintTailWindow)
        let tail = messages[start...]
        let tokens: [String] = tail.map { msg in
            if msg.role == .tool {
                let statusChar: String
                switch msg.toolStatus {
                case .running: statusChar = "r"
                case .completed: statusChar = "c"
                case .error: statusChar = "e"
                case .none: statusChar = "-"
                }
                return "\(msg.id):t\(statusChar)"
            }
            return "\(msg.id):\(msg.content.utf8.count)"
        }
        return tokens.joined(separator: ",")
    }

    /// Heal the main conversation when iOS's local transcript has drifted from
    /// the desktop's (dropped live deltas — e.g. a LAN↔relay transport switch or
    /// a seq gap mid-stream). The desktop snapshot carries a tail fingerprint
    /// (`convFingerprint`); iOS computes the SAME fingerprint over its local tail
    /// and re-fetches authoritative history when they diverge. This catches the
    /// failure modes the v1 timestamp heal could not: appended text on an
    /// existing assistant message, an in-place tool-status flip (lost tool_end,
    /// tool stuck "running"), and lost/new messages. When in sync — even
    /// mid-stream — the two fingerprints are identical, so normal streaming does
    /// NOT reload. Gated on: tab not actively streaming, tab loaded, not
    /// currently loading, the desktop sent a non-empty fingerprint, and past the
    /// per-tab debounce.
    @MainActor
    func maybeReconcileStaleConversation(tab: RemoteTabState) {
        // Cold-start / not-yet-streamed tabs send an empty fingerprint; nothing
        // to compare.
        guard let desktopFingerprint = tab.convFingerprint, !desktopFingerprint.isEmpty else { return }
        // While a run is in flight the desktop fingerprint always leads iOS by
        // the in-flight deltas. Firing loadConversation here would wipe the live
        // stream and cause a 1-2s blank flicker on every snapshot tick. Suppress
        // entirely; the one-shot post-run heal in handleTabStatus covers the
        // genuine-drop case once the run settles.
        guard tab.status != .running && tab.status != .connecting else {
            DiagnosticLog.log("SNAP: reconcile suppressed — tab streaming tabId=\(tab.id.prefix(16)) status=\(tab.status.rawValue)")
            return
        }

        // A load already in flight will deliver fresh history; don't pile on.
        guard !loadingConversation.contains(tab.id) else { return }

        let localMessages = conversationMessages(tab.id)
        let localFingerprint = conversationTailFingerprint(localMessages)

        // In sync → nothing to heal.
        guard localFingerprint != desktopFingerprint else { return }

        // Debounce per tab so a divergence that resolves on its own (a delta in
        // flight) within the window does not thrash the re-fetch.
        let now = Date()
        if let last = lastConversationReconcileAt[tab.id],
           now.timeIntervalSince(last) < Self.reconcileDebounce {
            return
        }
        lastConversationReconcileAt[tab.id] = now

        DiagnosticLog.log("SNAP: conv fingerprint diverged tabId=\(tab.id.prefix(16)) local=\(localFingerprint) desktop=\(desktopFingerprint) — healing via loadConversation")
        loadConversation(tabId: tab.id)
    }
}
