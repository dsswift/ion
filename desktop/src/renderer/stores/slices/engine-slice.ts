import type { TabStatus, TabState, EngineInstance } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'

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
      const instance: EngineInstance = { id, label }
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
      // Eagerly set the model override so it's available for iOS sync
      const prefs = usePreferencesStore.getState()
      const initialModel = prefs.engineDefaultModel || prefs.preferredModel || ''
      if (initialModel) {
        const overrides = new Map(get().engineModelOverrides)
        overrides.set(key, initialModel)
        set({ engineModelOverrides: overrides })
      }
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
              const messages = new Map(state.engineMessages)
              const msgs = [...(messages.get(key) || [])]
              msgs.push({ id: nextMsgId(), role: 'system' as const, content: `Failed to start engine: ${result.error}`, timestamp: Date.now() })
              messages.set(key, msgs)
              const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
              return { engineNotifications: notifications, engineMessages: messages, tabs }
            })
          }
        }).catch((err: any) => {
          console.error(`[engine] Start error: ${err.message}`)
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({ id: nextMsgId(), role: 'system' as const, content: `Engine start failed: ${err.message}`, timestamp: Date.now() })
            messages.set(key, msgs)
            const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
            return { engineMessages: messages, tabs }
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
        get().closeTab(tabId)
        set({ enginePanes: panes })
      } else {
        panes.set(tabId, { instances: remaining, activeInstanceId: activeId })
        set({ enginePanes: panes })
      }
      const engineMessages = new Map(get().engineMessages)
      const engineAgentStates = new Map(get().engineAgentStates)
      const engineStatusFields = new Map(get().engineStatusFields)
      const engineWorkingMessages = new Map(get().engineWorkingMessages)
      const engineNotifications = new Map(get().engineNotifications)
      const engineDialogs = new Map(get().engineDialogs)
      const enginePinnedPrompt = new Map(get().enginePinnedPrompt)
      const engineUsage = new Map(get().engineUsage)
      engineMessages.delete(key)
      engineAgentStates.delete(key)
      engineStatusFields.delete(key)
      engineWorkingMessages.delete(key)
      engineNotifications.delete(key)
      engineDialogs.delete(key)
      enginePinnedPrompt.delete(key)
      engineUsage.delete(key)
      const engineModelOverrides = new Map(get().engineModelOverrides)
      engineModelOverrides.delete(key)
      set({ engineMessages, engineAgentStates, engineStatusFields, engineWorkingMessages, engineNotifications, engineDialogs, enginePinnedPrompt, engineUsage, engineModelOverrides })
    },

    selectEngineInstance: (tabId, instanceId) => {
      const panes = new Map(get().enginePanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, { ...pane, activeInstanceId: instanceId })
      set({ enginePanes: panes })
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
      const key = `${tabId}:${instanceId}`
      const overrides = new Map(get().engineModelOverrides)
      overrides.set(key, modelId)
      set({ engineModelOverrides: overrides })
    },

    submitEnginePrompt: (tabId, text) => {
      const pane = get().enginePanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      const key = `${tabId}:${instanceId}`
      set((state) => {
        const pinnedPrompt = new Map(state.enginePinnedPrompt)
        pinnedPrompt.set(key, text)
        const messages = new Map(state.engineMessages)
        const msgs = [...(messages.get(key) || [])]
        msgs.push({ id: nextMsgId(), role: 'user' as const, content: text, timestamp: Date.now() })
        messages.set(key, msgs)
        const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const } : t)
        return { enginePinnedPrompt: pinnedPrompt, engineMessages: messages, tabs }
      })
      const prefs = usePreferencesStore.getState()
      const modelOverride = get().engineModelOverrides.get(key) || prefs.engineDefaultModel || prefs.preferredModel || undefined
      window.ion.enginePrompt(key, text, modelOverride).then((result) => {
        if (result && !result.ok) {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({ id: nextMsgId(), role: 'system' as const, content: `Error: ${result.error}`, timestamp: Date.now() })
            messages.set(key, msgs)
            const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
            return { engineMessages: messages, tabs }
          })
        }
      }).catch((err: any) => {
        set((state) => {
          const messages = new Map(state.engineMessages)
          const msgs = [...(messages.get(key) || [])]
          msgs.push({ id: nextMsgId(), role: 'system' as const, content: `Error: ${err.message}`, timestamp: Date.now() })
          messages.set(key, msgs)
          const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
          return { engineMessages: messages, tabs }
        })
      })
    },

    respondEngineDialog: (tabId, dialogId, value) => {
      const pane = get().enginePanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      const key = `${tabId}:${instanceId}`
      set((state) => {
        const dialogs = new Map(state.engineDialogs)
        dialogs.set(key, null)
        return { engineDialogs: dialogs }
      })
      window.ion.engineDialogResponse(key, dialogId, value)
    },
  }
}
