import type { TabStatus, TabState, EngineInstance, ConversationInstance } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { formatSessionStartDivider } from '../../../shared/clear-divider'
import { createEngineSubmitActions } from './engine-slice-submit'

export function createEngineSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    createEngineTab: (dir?: string, profileId?: string) => {
      const s = get()
      const homeDir = s.staticInfo?.homePath || '~'
      const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
      const workingDirectory = dir || defaultBase || homeDir

      const { tabGroupMode, tabGroups, engineProfiles } = usePreferencesStore.getState()
      const groupId = tabGroupMode === 'manual'
        ? (tabGroups.find((g) => g.isDefault)?.id || tabGroups[0]?.id || null)
        : null

      const profile = profileId ? engineProfiles.find((p) => p.id === profileId) : null
      const title = profile?.name || 'Engine'

      const newTab: TabState = {
        ...makeLocalTab(),
        title,
        isEngine: true,
        engineProfileId: profileId || null,
        workingDirectory,
        hasChosenDirectory: !!(dir || defaultBase),
        pillIcon: 'lightning',
        groupId,
        // Engine tabs start in auto mode regardless of the desktop default.
        // Extensions control plan mode via ctx.SetPlanMode — the user's
        // default permission mode preference applies to CLI tabs only.
        permissionMode: 'auto',
        // Clear the plan-model override that makeLocalTab may have set
        // (it applies the split model when defaultPermissionMode is 'plan').
        modelOverride: null,
      }

      set((state) => ({
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        tallViewTabId: usePreferencesStore.getState().defaultTallEngine ? newTab.id : null,
        terminalTallTabId: null,
      }))

      return newTab.id
    },

    addEngineInstance: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return ''
      const { engineProfiles } = usePreferencesStore.getState()
      const profile = tab.engineProfileId ? engineProfiles.find((p) => p.id === tab.engineProfileId) : null
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId) || { instances: [], activeInstanceId: null }
      const labelBase = profile?.name || 'Engine'
      const maxNum = pane.instances.reduce((max, i) => {
        const m = i.label.match(new RegExp(`^${labelBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`))
        return m ? Math.max(max, parseInt(m[1], 10)) : max
      }, 0)
      const label = `${labelBase} ${maxNum + 1}`
      const id = crypto.randomUUID().slice(0, 8)

      // Resolve initial model so it's available on the instance immediately
      // for iOS sync. engine_status will update this on the first status event.
      const prefs = usePreferencesStore.getState()
      const initialModel = prefs.engineDefaultModel || prefs.preferredModel || null

      // Session-start divider as the first message for this instance.
      // This is the only place it is created — on tab restoration,
      // addEngineInstance is skipped (instances already exist in enginePanes
      // from the restored snapshot), so no duplicate is produced.
      const startDivider = {
        id: nextMsgId(),
        role: 'system' as const,
        content: formatSessionStartDivider(new Date()),
        timestamp: Date.now(),
      }

      const instance: EngineInstance & ConversationInstance = {
        id,
        label,
        messages: [startDivider],
        modelOverride: initialModel,
        permissionMode: 'auto',
        permissionDenied: null,
        conversationIds: [],
        draftInput: '',
        agentStates: [],
        statusFields: null,
        planFilePath: null,
        forkedFromConversationIds: null,
      }
      panes.set(tabId, {
        instances: [...pane.instances, instance],
        activeInstanceId: id,
      })
      set((state) => ({
        enginePanes: panes,
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, status: 'connecting' as TabStatus } : t
        ),
      }))

      const key = `${tabId}:${id}`
      if (profile) {
        window.ion.engineStart(key, {
          profileId: profile.id,
          extensions: profile.extensions,
          workingDirectory: tab.workingDirectory,
        }).then((result) => {
          if (result && !result.ok) {
            console.error(`[engine] Failed to start session: ${result.error}`)
            set((state) => {
              const notifications = new Map(state.engineNotifications)
              const keyNotifs = [...(notifications.get(key) || [])]
              keyNotifs.push({ id: nextMsgId(), message: `Extension error: ${result.error}`, level: 'error', timestamp: Date.now() })
              notifications.set(key, keyNotifs)
              // Write error message onto instance
              const [tabIdInner, instanceId] = key.split(':')
              const enginePanes = new Map(state.enginePanes)
              const paneInner = enginePanes.get(tabIdInner)
              if (paneInner) {
                const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
                if (idx !== -1) {
                  const instances = paneInner.instances.slice()
                  const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Failed to start engine: ${result.error}`, timestamp: Date.now() }]
                  instances[idx] = { ...instances[idx], messages: msgs }
                  enginePanes.set(tabIdInner, { ...paneInner, instances })
                }
              }
              const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
              return { engineNotifications: notifications, enginePanes, tabs }
            })
          }
        }).catch((err: any) => {
          console.error(`[engine] Start error: ${err.message}`)
          set((state) => {
            const [tabIdInner, instanceId] = key.split(':')
            const enginePanes = new Map(state.enginePanes)
            const paneInner = enginePanes.get(tabIdInner)
            if (paneInner) {
              const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
              if (idx !== -1) {
                const instances = paneInner.instances.slice()
                const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Engine start failed: ${err.message}`, timestamp: Date.now() }]
                instances[idx] = { ...instances[idx], messages: msgs }
                enginePanes.set(tabIdInner, { ...paneInner, instances })
              }
            }
            const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
            return { enginePanes, tabs }
          })
        })
      } else {
        window.ion.engineStart(key, {
          profileId: '',
          extensions: [],
          workingDirectory: tab.workingDirectory,
        }).catch((err: any) => {
          console.error(`[engine] Start error (no profile): ${err.message}`)
        })
      }
      return id
    },

    removeEngineInstance: (tabId, instanceId) => {
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) return
      const key = `${tabId}:${instanceId}`
      window.ion.engineAbort(key).catch(() => {})
      const remaining = pane.instances.filter((i) => i.id !== instanceId)
      const activeId = pane.activeInstanceId === instanceId
        ? (remaining[remaining.length - 1]?.id || null)
        : pane.activeInstanceId
      if (remaining.length === 0) {
        panes.delete(tabId)
        // The user explicitly closed the last engine sub-tab via the
        // EngineInstanceCloseConfirmDialog, and engineAbort fired
        // above for the corresponding key. The closeTab guard reads
        // instance.statusFields / instance.agentStates on the instance;
        // by the time it runs the abort will have started flipping
        // those entries to idle. If a race window exists, the guard
        // logs a refusal and the tab stays open — the user can
        // re-attempt close once children finish aborting.
        get().closeTab(tabId)
        set({ enginePanes: panes })
      } else {
        panes.set(tabId, { instances: remaining, activeInstanceId: activeId })
        set({ enginePanes: panes })
      }
      // ConversationInstance fields are carried on the instance object itself
      // and are gone when the instance is removed from panes above.
      // Clean up the non-ConversationInstance compound-keyed Maps.
      const engineWorkingMessages = new Map(get().engineWorkingMessages)
      const engineNotifications = new Map(get().engineNotifications)
      const engineDialogs = new Map(get().engineDialogs)
      const enginePinnedPrompt = new Map(get().enginePinnedPrompt)
      const engineUsage = new Map(get().engineUsage)
      engineWorkingMessages.delete(key)
      engineNotifications.delete(key)
      engineDialogs.delete(key)
      enginePinnedPrompt.delete(key)
      engineUsage.delete(key)
      set({ engineWorkingMessages, engineNotifications, engineDialogs, enginePinnedPrompt, engineUsage })
    },

    resetEngineInstance: (tabId, instanceId) => {
      // Engine-instance counterpart to resetTabSession: stop the engine
      // session and wipe per-instance state, but keep the instance pane
      // itself so the user stays on the same tab/sub-tab. Mirrors the
      // CLI-side resetTabSession on engine-control-plane.ts which keeps
      // the tab open and zeros out conversationId/promptCount.
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) return
      const instanceExists = pane.instances.some((i) => i.id === instanceId)
      if (!instanceExists) return
      const key = `${tabId}:${instanceId}`
      // engineAbort tears down the engine session keyed by `${tabId}:${instanceId}`.
      // Same primitive removeEngineInstance uses; here we keep the pane entry.
      window.ion.engineAbort(key).catch(() => {})

      // Fresh divider message for the reset boundary.
      const divider = {
        id: nextMsgId(),
        role: 'system' as const,
        content: formatSessionStartDivider(new Date()),
        timestamp: Date.now(),
      }

      // Write ConversationInstance zero values directly onto the instance.
      // Clear the conversation ID chain — the reset starts a fresh engine
      // session; the old chain must not carry over or the next engine_status
      // sessionId append would extend stale history instead of starting a
      // new chain. The new session ID arrives via engine_status after the
      // engine restarts and is appended there.
      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => {
          if (i.id !== instanceId) return i
          return {
            ...i,
            messages: [divider],
            modelOverride: i.modelOverride,  // preserve model selection across reset
            permissionMode: 'auto' as const,
            permissionDenied: null,
            conversationIds: [],
            draftInput: '',
            agentStates: [],
            statusFields: null,
            planFilePath: null,
            forkedFromConversationIds: null,
          }
        }),
      })

      // Clean up non-ConversationInstance compound-keyed Maps.
      const engineWorkingMessages = new Map(get().engineWorkingMessages)
      const engineNotifications = new Map(get().engineNotifications)
      const engineDialogs = new Map(get().engineDialogs)
      const enginePinnedPrompt = new Map(get().enginePinnedPrompt)
      const engineUsage = new Map(get().engineUsage)
      engineWorkingMessages.delete(key)
      engineNotifications.delete(key)
      engineDialogs.delete(key)
      enginePinnedPrompt.delete(key)
      engineUsage.delete(key)

      set({ enginePanes: panes, engineWorkingMessages, engineNotifications, engineDialogs, enginePinnedPrompt, engineUsage })
    },

    rewindEngineInstance: (tabId, instanceId, messageId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) {
        console.warn(`[engine] rewindEngineInstance: tab not found tabId=${tabId.slice(0, 8)}`)
        return
      }
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) {
        console.warn(`[engine] rewindEngineInstance: pane not found tabId=${tabId.slice(0, 8)}`)
        return
      }
      const inst = pane.instances.find((i) => i.id === instanceId)
      if (!inst) {
        console.warn(`[engine] rewindEngineInstance: instance not found tabId=${tabId.slice(0, 8)} instanceId=${instanceId}`)
        return
      }
      const idx = inst.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) {
        console.warn(`[engine] rewindEngineInstance: message not found tabId=${tabId.slice(0, 8)} instanceId=${instanceId} messageId=${messageId}`)
        return
      }

      const targetMessage = inst.messages[idx]
      const key = `${tabId}:${instanceId}`
      const priorConvIds = inst.conversationIds.length > 0 ? [...inst.conversationIds] : null
      console.log(`[engine] rewindEngineInstance: key=${key} msgIdx=${idx} totalMsgs=${inst.messages.length} keepMsgs=${idx} priorConvIds=${JSON.stringify(priorConvIds)} targetMsgLen=${targetMessage.content.length}`)

      // Stop the engine session completely (not just abort the current run).
      // A rewind must start a fresh conversation — aborting would leave the
      // old conversation file intact and the next send_prompt would append to
      // it, creating a confusing state where the engine has full pre-rewind
      // history but the desktop shows truncated messages.
      window.ion.engineStop(key).then(() => {
        console.log(`[engine] rewindEngineInstance: session stopped key=${key}, starting fresh session`)
        // Start a fresh session with the same key. No sessionId is passed,
        // so the engine allocates a new conversation file. The prior context
        // is injected as appendSystemPrompt on the next prompt (see
        // engine-slice-submit.ts fork context injection).
        const { engineProfiles } = usePreferencesStore.getState()
        const profile = tab.engineProfileId ? engineProfiles.find((p) => p.id === tab.engineProfileId) : null
        window.ion.engineStart(key, {
          profileId: profile?.id || '',
          extensions: profile?.extensions || [],
          workingDirectory: tab.workingDirectory,
        }).then(() => {
          console.log(`[engine] rewindEngineInstance: fresh session started key=${key} profile=${profile?.id || 'none'}`)
        }).catch((err: any) => {
          console.error(`[engine] rewindEngineInstance: restart failed key=${key} err=${err.message}`)
        })
      }).catch((err: any) => {
        console.error(`[engine] rewindEngineInstance: stop failed key=${key} err=${(err as Error).message}`)
      })

      const rewoundMessages = inst.messages.slice(0, idx)

      // Restore permissionDenied from the last tool message in the truncated
      // history, same heuristic as CLI rewindToMessage in resume-slice.ts.
      const parseInput = (raw?: string): Record<string, unknown> | undefined => {
        if (!raw) return undefined
        try { return JSON.parse(raw) } catch { return undefined }
      }
      const lastToolMsg = [...rewoundMessages].reverse().find((m) => m.toolName)
      const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
        ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseInput(lastToolMsg.toolInput) }] }
        : null

      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => {
          if (i.id !== instanceId) return i
          return {
            ...i,
            messages: rewoundMessages,
            modelOverride: i.modelOverride,  // preserve model selection across rewind
            permissionMode: i.permissionMode, // preserve permission mode across rewind
            permissionDenied: restoredDenied,
            conversationIds: [],
            draftInput: targetMessage.content,
            agentStates: [],
            statusFields: null,
            planFilePath: null,
            forkedFromConversationIds: i.conversationIds.length > 0 ? [...i.conversationIds] : null,
          }
        }),
      })

      // Clean up compound-keyed Maps — same as resetEngineInstance.
      const engineWorkingMessages = new Map(get().engineWorkingMessages)
      const engineNotifications = new Map(get().engineNotifications)
      const engineDialogs = new Map(get().engineDialogs)
      const enginePinnedPrompt = new Map(get().enginePinnedPrompt)
      const engineUsage = new Map(get().engineUsage)
      engineWorkingMessages.delete(key)
      engineNotifications.delete(key)
      engineDialogs.delete(key)
      enginePinnedPrompt.delete(key)
      engineUsage.delete(key)

      set((state) => ({
        enginePanes: panes,
        engineWorkingMessages,
        engineNotifications,
        engineDialogs,
        enginePinnedPrompt,
        engineUsage,
        // Set pendingInput on the parent TabState so InputBar pre-fills
        // immediately (same one-shot pattern as CLI rewindToMessage).
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, pendingInput: targetMessage.content }
            : t
        ),
      }))
    },

    selectEngineInstance: (tabId, instanceId) => {
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, { ...pane, activeInstanceId: instanceId })

      // Reconcile tab.status from the newly-active instance's known
      // state so the thinking indicator, interrupt button, and status
      // bar correctly reflect the selected sub-tab. Without this, the
      // tab status stays frozen at whatever the *previous* instance
      // last set — e.g. stuck 'running' after switching to an idle
      // instance.
      const instance = pane.instances.find((i) => i.id === instanceId)
      const instanceState = instance?.statusFields?.state
      const denial = instance?.permissionDenied

      // Also sync conversationId so the status bar footer shows the
      // correct conversation for the newly-active instance.
      const convChain = instance?.conversationIds
      const lastConvId = convChain && convChain.length > 0 ? convChain[convChain.length - 1] : undefined

      // Resolve the per-instance permission mode so the footer dropdown
      // reflects this subtab's mode immediately on switch.
      const instancePermissionMode = instance?.permissionMode ?? 'auto'

      if (instanceState) {
        // Map instance state to tab.status — mirrors the logic in
        // engine-event-status.ts:167-181.
        let newStatus: TabStatus
        if (instanceState === 'running' || instanceState === 'connecting' || instanceState === 'starting') {
          newStatus = 'running'
        } else if (instanceState === 'idle') {
          // Check for "interesting" denials (AskUserQuestion / ExitPlanMode)
          const hasInterestingDenials = denial?.tools?.some(
            (t) => t.toolName === 'AskUserQuestion' || t.toolName === 'ExitPlanMode',
          ) ?? false
          newStatus = hasInterestingDenials ? 'completed' : 'idle'
        } else {
          newStatus = 'idle'
        }

        console.log(`[selectEngineInstance] tab=${tabId.slice(0, 8)} instance=${instanceId} reconciledStatus=${newStatus}`)

        set((state) => ({
          enginePanes: panes,
          tabs: state.tabs.map((t) => {
            if (t.id !== tabId) return t
            const updates: Partial<typeof t> = { status: newStatus, permissionMode: instancePermissionMode }
            if (lastConvId && t.conversationId !== lastConvId) {
              updates.conversationId = lastConvId
              updates.lastKnownSessionId = lastConvId
            }
            return { ...t, ...updates }
          }),
        }))
      } else {
        // No status entry yet (instance just created, no events
        // received) — update panes and conversationId only, leave
        // tab.status unchanged. Still reconcile permissionMode.
        console.log(`[selectEngineInstance] tab=${tabId.slice(0, 8)} instance=${instanceId} noStatusEntry, panes only`)
        if (lastConvId) {
          set((state) => ({
            enginePanes: panes,
            tabs: state.tabs.map((t) => {
              if (t.id !== tabId) return t
              if (t.conversationId === lastConvId && t.permissionMode === instancePermissionMode) return { ...t }
              return { ...t, conversationId: lastConvId, lastKnownSessionId: lastConvId, permissionMode: instancePermissionMode }
            }),
          }))
        } else {
          set((state) => ({
            enginePanes: panes,
            tabs: state.tabs.map((t) => {
              if (t.id !== tabId) return t
              if (t.permissionMode === instancePermissionMode) return { ...t }
              return { ...t, permissionMode: instancePermissionMode }
            }),
          }))
        }
      }
    },

    renameEngineInstance: (tabId, instanceId, label) => {
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => i.id === instanceId ? { ...i, label } : i),
      })
      set({ enginePanes: panes })
    },

    moveEngineInstance: (sourceTabId, instanceId, targetTabId) => {
      const state = get()
      const sourcePaneRaw = state.enginePanes.get(sourceTabId)
      const targetPaneRaw = state.enginePanes.get(targetTabId)
      if (!sourcePaneRaw) {
        console.warn(`[engine] moveEngineInstance: source pane not found tabId=${sourceTabId}`)
        return
      }
      const instance = sourcePaneRaw.instances.find((i) => i.id === instanceId)
      if (!instance) {
        console.warn(`[engine] moveEngineInstance: instance ${instanceId} not found in tab ${sourceTabId}`)
        return
      }
      const targetTab = state.tabs.find((t) => t.id === targetTabId)
      if (!targetTab?.isEngine) {
        console.warn(`[engine] moveEngineInstance: target tab ${targetTabId} is not an engine tab`)
        return
      }

      const oldKey = `${sourceTabId}:${instanceId}`
      const newKey = `${targetTabId}:${instanceId}`
      console.log(`[engine] moveEngineInstance: ${oldKey} -> ${newKey}`)

      // The instance object carries all ConversationInstance fields — it moves
      // with the instance when we update enginePanes. No per-field Map rekeying
      // is needed for the migrated fields.
      //
      // Rekey the non-ConversationInstance compound-keyed Maps.
      const engineWorkingMessages = new Map(state.engineWorkingMessages)
      const engineNotifications = new Map(state.engineNotifications)
      const engineDialogs = new Map(state.engineDialogs)
      const enginePinnedPrompt = new Map(state.enginePinnedPrompt)
      const engineUsage = new Map(state.engineUsage)

      const rekey = <V>(m: Map<string, V>) => {
        if (m.has(oldKey)) { m.set(newKey, m.get(oldKey)!); m.delete(oldKey) }
      }
      rekey(engineWorkingMessages)
      rekey(engineNotifications)
      rekey(engineDialogs)
      rekey(enginePinnedPrompt)
      rekey(engineUsage)

      // Update enginePanes: remove from source, add to target.
      // The instance object (with all ConversationInstance fields) moves as-is.
      const enginePanes = new Map(state.enginePanes)
      const sourceRemaining = sourcePaneRaw.instances.filter((i) => i.id !== instanceId)
      if (sourceRemaining.length === 0) {
        enginePanes.delete(sourceTabId)
      } else {
        const newActiveId = sourcePaneRaw.activeInstanceId === instanceId
          ? (sourceRemaining[sourceRemaining.length - 1]?.id || null)
          : sourcePaneRaw.activeInstanceId
        enginePanes.set(sourceTabId, { instances: sourceRemaining, activeInstanceId: newActiveId })
      }

      const targetPane = targetPaneRaw || { instances: [], activeInstanceId: null }
      enginePanes.set(targetTabId, {
        instances: [...targetPane.instances, instance],
        activeInstanceId: instance.id,
      })

      set({
        enginePanes,
        engineWorkingMessages,
        engineNotifications,
        engineDialogs,
        enginePinnedPrompt,
        engineUsage,
      })

      // Close source tab if it's now empty. If the source tab still
      // has running orchestrators/children (race window or unrelated
      // sibling instance not moved), the closeTab guard will refuse
      // and log — the source tab stays open until it's truly idle.
      if (sourceRemaining.length === 0) {
        get().closeTab(sourceTabId)
      }

      // Tell the bridge to remap the session key so future events route correctly
      window.ion.engineRemapSession(oldKey, newKey)
    },

    reorderEngineInstances: (tabId, reordered) => {
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, { ...pane, instances: reordered })
      set({ enginePanes: panes })
    },

    setEngineModel: (tabId, modelId) => {
      const pane = get().enginePanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      // Write modelOverride directly onto the instance.
      set((state) => {
        const enginePanes = new Map(state.enginePanes)
        const paneInner = enginePanes.get(tabId)
        if (!paneInner) return {}
        const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
        if (idx === -1) return {}
        const instances = paneInner.instances.slice()
        instances[idx] = { ...instances[idx], modelOverride: modelId }
        enginePanes.set(tabId, { ...paneInner, instances })
        return { enginePanes }
      })
    },

    ...createEngineSubmitActions(set, get),
  }
}
