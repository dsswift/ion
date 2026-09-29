import Foundation

// MARK: - Snapshot Handling

extension SessionViewModel {

    @MainActor
    func handleSnapshot(snapshotTabs: [RemoteTabState], recentDirs: [String], availableModels: [RemoteModelEntry]? = nil, projects: [RemoteProject] = [], worktreeStates: [RemoteWorktreeState]? = nil, settledTabs: [RemoteTabState]? = nil) {
        DiagnosticLog.log("snapshot received", tag: "session.snapshot", fields: [
            "count": String(snapshotTabs.count),
            "max": String(recentDirs.count),
            "reason": String(availableModels?.count ?? 0)
        ])
        // Log any tabs that arrive with a non-empty permission queue so we can
        // confirm the blue dot has the data it needs at relaunch.
        for t in snapshotTabs where !t.permissionQueue.isEmpty {
            let tools = t.permissionQueue.map { "\($0.toolName)(id=\($0.questionId.prefix(12)))" }.joined(separator: ", ")
            DiagnosticLog.log("snapshot tab permission queue", tag: "session.snapshot", fields: [
                "tab_id": String(t.id.prefix(8)),
                "status": t.status.rawValue,
                "tool": tools
            ])
        }
        for t in snapshotTabs where t.hasEngineExtension == true && t.permissionQueue.isEmpty {
            if t.status == .completed || t.status == .idle {
                DiagnosticLog.log("snapshot engine tab empty queue", tag: "session.snapshot", fields: [
                    "tab_id": String(t.id.prefix(8)),
                    "status": t.status.rawValue
                ])
            }
        }
        if connectionState != .connected {
            if let deviceId = activeDevice?.id {
                // A decrypted snapshot can arrive only after relay bearer + E2E
                // validation or LAN challenge-response + E2E validation. This is
                // precise authorization proof, not a freshness guess.
                authorizeServer(deviceId: deviceId)
            }
            DiagnosticLog.log("snapshot connected", tag: "session.snapshot", fields: [
                "reason": String(describing: connectionState)
            ])
            connectionState = .connected
            cancelReconnectSafetyTimer()
            // RC-20: a reconnect gives the desktop a fresh chance to answer image
            // fetches, so clear any transient failed/orphaned-pending state that
            // accrued while disconnected — otherwise an image that failed to fetch
            // during the outage stays blank forever.
            RemoteImageFetcher.shared.resetTransientState()
            // The transport is now proven usable (we just got a real
            // snapshot back from the desktop), so release any commands
            // that were deferred via `runWhenConnected` during the
            // reconnect window — e.g. the scene-resume git refresh and
            // focus report. Order matters: we flip state first so that
            // a drained block which re-checks `connectionState` (or
            // calls `runWhenConnected` again) sees `.connected` and
            // runs inline rather than re-queueing.
            drainPendingOnConnected()
            // A System Metrics watch belongs to one server connection, and
            // this is a new one. The phone only connects in the foreground.
            startSystemMetricsWatch()
            // Every transcript stream was subscribed on the connection that
            // just ended; the server holds none for this one. Ask each anew
            // before the queue drains, so a page request queued while
            // disconnected is superseded rather than sent twice.
            resyncAllTranscripts(reason: "reconnect")
            resyncAllDispatchTranscripts(reason: "reconnect")
            drainPendingEssential()
            // Resend any in-flight tab-create that was issued while the
            // transport was wedged/reconnecting, so it lands now instead of
            // waiting out its timeout. The desktop dedupes by clientCmdId.
            resendPendingCreates()
        }
        connectionQuality.transportState = transport?.state ?? .disconnected
        connectionHealth.recordLiveSync()
        if !recentDirs.isEmpty {
            recentDirectories = recentDirs
        }
        self.projects = projects
        if let models = availableModels, !models.isEmpty {
            self.availableModels = models
        }
        // Snapshot fields replace the first-render navigator cache. Incremental
        // desktop_worktree_state events still update the same state afterwards.
        if let worktreeStates {
            self.worktreeStates = Dictionary(uniqueKeysWithValues: worktreeStates.map { ($0.repoPath, $0) })
        }
        if let settledTabs {
            self.settledTabs = settledTabs
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
                    DiagnosticLog.log("snapshot stripped stale denied entry", tag: "session.snapshot", fields: [
                        "tab_id": tabIdPrefix,
                        "status": tabStatus,
                        "tool": entry.toolName,
                        "question_id": String(entry.questionId.prefix(16))
                    ])
                    return true
                }
                if dismissedLiveSpecialTabs.contains(tabId) { return true }
                if let instanceId = entry.instanceId,
                   dismissedLiveSpecialTabs.contains("\(tabId):\(instanceId)") {
                    return true
                }
                return false
            }

            // Record which promoted special cards this snapshot vouches for (see
            // snapshotConfirmedSpecialIds). Cap growth; a false re-preserve is benign.
            for entry in merged[i].permissionQueue
            where entry.toolName == "ExitPlanMode" || entry.toolName == "AskUserQuestion" {
                snapshotConfirmedSpecialIds.insert(entry.questionId)
            }
            if snapshotConfirmedSpecialIds.count > 1000 { snapshotConfirmedSpecialIds.removeAll() }

            if let existing = tabs.first(where: { $0.id == tabId }),
               !existing.permissionQueue.isEmpty {
                // Keep existing local queue entries that aren't in the snapshot
                let snapshotIds = Set(merged[i].permissionQueue.map(\.questionId))
                let isRunning = merged[i].status == .running
                let localOnly = existing.permissionQueue.filter { entry in
                    if snapshotIds.contains(entry.questionId) { return false }
                    let isSpecial = entry.toolName == "ExitPlanMode" || entry.toolName == "AskUserQuestion"
                    // Don't re-inject stale plan/question cards once a new task is running
                    if isRunning && isSpecial {
                        return false
                    }
                    // Confirmed-then-omitted: the desktop resolved this card, so
                    // the snapshot is authoritative — drop it (see the field doc).
                    if isSpecial && snapshotConfirmedSpecialIds.contains(entry.questionId) {
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
        // Guided Questions: the snapshot's per-tab questions field is
        // authoritative for first paint and seq-gap recovery (absent clears).
        mergeQuestionsFromSnapshot(merged)
        // From here on, a tab id absent from `tabIds` is authoritative: the
        // desktop has told us its full tab list at least once. Views use this
        // to distinguish "conversation was closed" from "not synced yet"
        // before dropping a stale navigation destination.
        hasAppliedTabSnapshot = true
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
        // Drop drafts for closed conversations and take the host's draft for
        // the ones this device is not editing. Both live in
        // SessionViewModel+Drafts.swift, beside the store they touch.
        reconcileDraftsWithSnapshot(merged, liveTabIds: mergedIds)
        // Populate terminal state from snapshot tab data
        for tab in merged {
            // DATA-driven, not tab-type-gated (same rationale as the
            // conversationInstances handling below): the desktop snapshot
            // projects `terminalInstances` for ANY tab with a terminal pane —
            // conversation tabs included — so we populate terminal state
            // whenever the snapshot carries instances. The former
            // `tab.isTerminalOnly == true` guard discarded a conversation
            // tab's terminal instances, leaving its terminal pane empty.
            if let instances = tab.terminalInstances {
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
                //     isRunning, runningAgentCount, backgroundShellCount,
                //     activeBackgroundTasks, modelFallback, resolvedModel, thinkingEffort. These are authoritative
                //     from the desktop snapshot every tick, so EVERY one of
                //     them must be copied in the merge below — a field added to
                //     the struct but not to the merge is silently frozen at
                //     whatever it held when the instance was first seen.
                //   - Runtime-only (excluded from Codable): messages,
                //     agentStates, statusFields, modelOverride. These are
                //     populated by live events and the transcript stream,
                //     and must survive the snapshot reassignment.
                //
                // Rebuilding the instances from the snapshot alone would wipe
                // the transcript rows on every snapshot. The merge below
                // preserves runtime state and updates the snapshot fields.
                let existing = conversationInstances[tab.id] ?? []
                conversationInstances[tab.id] = instances.map { snap in
                    if var prior = existing.first(where: { $0.id == snap.id }) {
                        prior.label = snap.label
                        prior.waitingState = snap.waitingState
                        prior.isRunning = snap.isRunning
                        prior.runningAgentCount = snap.runningAgentCount
                        prior.backgroundShellCount = snap.backgroundShellCount
                        prior.activeBackgroundTasks = snap.activeBackgroundTasks
                        prior.modelFallback = snap.modelFallback
                        prior.resolvedModel = snap.resolvedModel
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
                    // and are populated by the transcript stream and live
                    // events.
                    return snap
                }
                activeEngineInstance[tab.id] = ConversationInstanceInfo.resolveActiveInstanceId(
                    activeId: tab.activeConversationInstanceId,
                    instances: instances
                )
                DiagnosticLog.log("snapshot conversation tab instances", tag: "session.snapshot", fields: [
                    "tab_id": String(tab.id.prefix(8)),
                    "instances": instances.map(\.id).joined(separator: ","),
                    "active": tab.activeConversationInstanceId ?? "nil"
                ])
                // Open the transcript of every conversation the phone does
                // not hold yet, so a conversation renders complete the moment
                // it is opened. One already held is kept current by patches;
                // this only checks its rows survived the merge above.
                if transcriptStreams[tab.id] == nil {
                    requestTranscript(tabId: tab.id, reason: "snapshot_preload")
                } else {
                    verifyTranscriptWindow(tabId: tab.id)
                }
            }
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
                recentDirectories: recentDirectories
            )
        }

        // Send voice configuration so the desktop knows current voice settings.
        sendVoiceConfig()
    }

}
