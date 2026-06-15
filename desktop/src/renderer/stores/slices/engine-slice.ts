import type { TabStatus, TabState, ConversationRef, ConversationInstance } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { formatSessionStartDivider } from '../../../shared/clear-divider'
import { createEngineSubmitActions } from './engine-slice-submit'
import { createEngineRewindActions } from './engine-slice-rewind'
import { parseSessionKey } from '../../../shared/session-key'

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
        hasEngineExtension: true,
        engineProfileId: profileId || null,
        workingDirectory,
        hasChosenDirectory: !!(dir || defaultBase),
        pillIcon: 'lightning',
        groupId,
        // Engine tabs start in auto mode regardless of the desktop default.
        // Extensions control plan mode via ctx.SetPlanMode — the user's
        // default permission mode preference applies to CLI tabs only.
        permissionMode: 'auto',
        // NB: the engine instance's modelOverride is seeded in
        // addEngineInstance (from engineDefaultModel/preferredModel); the
        // old tab-level `modelOverride: null` reset is gone since that field
        // no longer lives on TabState.
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
      const panes = new Map(get().conversationPanes)
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
      // addEngineInstance is skipped (instances already exist in conversationPanes
      // from the restored snapshot), so no duplicate is produced.
      const startDivider = {
        id: nextMsgId(),
        role: 'system' as const,
        content: formatSessionStartDivider(new Date()),
        timestamp: Date.now(),
      }

      const instance: ConversationRef & ConversationInstance = {
        id,
        label,
        messages: [startDivider],
        messageCount: 1,  // one message: the session-start divider
        modelOverride: initialModel,
        sessionModel: null,
        permissionMode: 'auto',
        permissionDenied: null,
        permissionQueue: [],
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
        conversationPanes: panes,
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
              const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
              const conversationPanes = new Map(state.conversationPanes)
              const paneInner = conversationPanes.get(tabIdInner)
              if (paneInner) {
                const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
                if (idx !== -1) {
                  const instances = paneInner.instances.slice()
                  const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Failed to start engine: ${result.error}`, timestamp: Date.now() }]
                  instances[idx] = { ...instances[idx], messages: msgs }
                  conversationPanes.set(tabIdInner, { ...paneInner, instances })
                }
              }
              const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
              return { engineNotifications: notifications, conversationPanes, tabs }
            })
          }
        }).catch((err: any) => {
          console.error(`[engine] Start error: ${err.message}`)
          set((state) => {
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const conversationPanes = new Map(state.conversationPanes)
            const paneInner = conversationPanes.get(tabIdInner)
            if (paneInner) {
              const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
              if (idx !== -1) {
                const instances = paneInner.instances.slice()
                const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Engine start failed: ${err.message}`, timestamp: Date.now() }]
                instances[idx] = { ...instances[idx], messages: msgs }
                conversationPanes.set(tabIdInner, { ...paneInner, instances })
              }
            }
            const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
            return { conversationPanes, tabs }
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
      const panes = new Map(get().conversationPanes)
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
        set({ conversationPanes: panes })
      } else {
        panes.set(tabId, { instances: remaining, activeInstanceId: activeId })
        set({ conversationPanes: panes })
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
      const panes = new Map(get().conversationPanes)
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
            messageCount: 1,  // one message: the reset-boundary divider
            modelOverride: i.modelOverride,  // preserve model selection across reset
            sessionModel: null,  // engine reports a fresh model on the next status event
            permissionMode: 'auto' as const,
            permissionDenied: null,
            permissionQueue: [],
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

      set({ conversationPanes: panes, engineWorkingMessages, engineNotifications, engineDialogs, enginePinnedPrompt, engineUsage })
    },

    rewindEngineInstance: createEngineRewindActions(set, get).rewindEngineInstance!,

    selectEngineInstance: (tabId, instanceId) => {
      const panes = new Map(get().conversationPanes)
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
          conversationPanes: panes,
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
            conversationPanes: panes,
            tabs: state.tabs.map((t) => {
              if (t.id !== tabId) return t
              if (t.conversationId === lastConvId && t.permissionMode === instancePermissionMode) return { ...t }
              return { ...t, conversationId: lastConvId, lastKnownSessionId: lastConvId, permissionMode: instancePermissionMode }
            }),
          }))
        } else {
          set((state) => ({
            conversationPanes: panes,
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
      const panes = new Map(get().conversationPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => i.id === instanceId ? { ...i, label } : i),
      })
      set({ conversationPanes: panes })
    },

    moveEngineInstance: (sourceTabId, instanceId, targetTabId) => {
      const state = get()
      const sourcePaneRaw = state.conversationPanes.get(sourceTabId)
      const targetPaneRaw = state.conversationPanes.get(targetTabId)
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
      if (!targetTab?.hasEngineExtension) {
        console.warn(`[engine] moveEngineInstance: target tab ${targetTabId} is not an engine tab`)
        return
      }

      const oldKey = `${sourceTabId}:${instanceId}`
      const newKey = `${targetTabId}:${instanceId}`
      console.log(`[engine] moveEngineInstance: ${oldKey} -> ${newKey}`)

      // The instance object carries all ConversationInstance fields — it moves
      // with the instance when we update conversationPanes. No per-field Map rekeying
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

      // Update conversationPanes: remove from source, add to target.
      // The instance object (with all ConversationInstance fields) moves as-is.
      const conversationPanes = new Map(state.conversationPanes)
      const sourceRemaining = sourcePaneRaw.instances.filter((i) => i.id !== instanceId)
      if (sourceRemaining.length === 0) {
        conversationPanes.delete(sourceTabId)
      } else {
        const newActiveId = sourcePaneRaw.activeInstanceId === instanceId
          ? (sourceRemaining[sourceRemaining.length - 1]?.id || null)
          : sourcePaneRaw.activeInstanceId
        conversationPanes.set(sourceTabId, { instances: sourceRemaining, activeInstanceId: newActiveId })
      }

      const targetPane = targetPaneRaw || { instances: [], activeInstanceId: null }
      conversationPanes.set(targetTabId, {
        instances: [...targetPane.instances, instance],
        activeInstanceId: instance.id,
      })

      set({
        conversationPanes,
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
      const panes = new Map(get().conversationPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, { ...pane, instances: reordered })
      set({ conversationPanes: panes })
    },

    setEngineModel: (tabId, modelId) => {
      const pane = get().conversationPanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      // Write modelOverride directly onto the instance.
      set((state) => {
        const conversationPanes = new Map(state.conversationPanes)
        const paneInner = conversationPanes.get(tabId)
        if (!paneInner) return {}
        const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
        if (idx === -1) return {}
        const instances = paneInner.instances.slice()
        instances[idx] = { ...instances[idx], modelOverride: modelId }
        conversationPanes.set(tabId, { ...paneInner, instances })
        return { conversationPanes }
      })
    },

    ...createEngineSubmitActions(set, get),
  }
}
