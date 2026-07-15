import type { TabStatus } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { formatSessionStartDivider } from '../../../shared/clear-divider'
import { createEngineSubmitActions } from './engine-slice-submit'
import { createEngineRewindActions } from './engine-slice-rewind'
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'
import { createConversationTabAction, _captureMintedConversationId } from './engine-slice-create'
import { rError } from '../../rendererLogger'

/**
 * Engine slice: single-instance-per-tab lifecycle.
 *
 * Phase 1 (#256): collapsed multi-instance container. A tab has exactly one
 * engine instance. Multiplexing operations removed.
 *
 * Phase 2 (#256): createConversationTab is the unified entry point for all tab
 * kinds. Both plain and extension-hosted tabs go through the same async creation
 * path (real engine tab ID from main process, seeded `main` pane with
 * session-start divider). Extension presence is derived from the resolved
 * extension list, not the entry point.
 * Session key for ALL tabs: the bare `tabId` (Phase 4b).
 */
export function createEngineSlice(set: StoreSet, get: StoreGet): Partial<State> {
  const createConversationTab = createConversationTabAction(set, get)

  return {
    createConversationTab,

    /**
     * Auto-create guard: called by EngineView when a tab has no pane yet.
     *
     * With Phase 2, createConversationTab seeds the pane at creation time, so
     * this guard fires only for tabs that were created through a legacy path
     * (e.g. tabs restored from a snapshot that predates the unified create, or
     * tabs created directly via the old sync entry point before the app
     * reloads). It is a no-op when the pane already exists.
     *
     * The guard still starts the engine for the `main` instance so that any
     * pre-Phase-2 tabs (without a seeded pane) behave correctly on first render.
     */
    addEngineInstance: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return ''

      // Single-instance guard: pane already seeded by createConversationTab.
      const existingPane = get().conversationPanes.get(tabId)
      if (existingPane && existingPane.instances.length > 0) {
        return existingPane.instances[0].id
      }

      // Legacy path: pane not yet seeded. Create the main instance inline.
      // This handles tabs restored from pre-Phase-2 snapshots.
      const { engineProfiles } = usePreferencesStore.getState()
      const profile = tab.engineProfileId ? engineProfiles.find((p) => p.id === tab.engineProfileId) : null
      const prefs = usePreferencesStore.getState()
      const initialModel = prefs.engineDefaultModel || prefs.preferredModel || null

      const startDivider = {
        id: nextMsgId(),
        role: 'system' as const,
        content: formatSessionStartDivider(new Date()),
        timestamp: Date.now(),
      }

      // Use bare tabId as the session key (Phase 4b).
      const id = MAIN_INSTANCE_ID
      const label = profile?.name ? `${profile.name} 1` : 'Engine 1'

      const panes = new Map(get().conversationPanes)
      panes.set(tabId, {
        instances: [{
          id,
          label,
          messages: [startDivider],
          messageCount: 1,
          modelOverride: initialModel,
          sessionModel: null,
          permissionMode: 'auto' as const,
          permissionDenied: null,
          permissionQueue: [],
          elicitationQueue: [],
          conversationIds: [],
          draftInput: '',
          agentStates: [],
          statusFields: null,
          planFilePath: null,
          forkedFromConversationIds: null, dispatchTelemetry: [],
          contextBreakdown: null,
        }],
        activeInstanceId: id,
      })
      set((state) => ({
        conversationPanes: panes,
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, status: 'connecting' as TabStatus } : t
        ),
      }))

      const key = tabId
      const startOpts = {
        profileId: profile?.id || '',
        extensions: profile?.extensions ?? [],
        workingDirectory: tab.workingDirectory,
        // Consume a pending checkpoint-cut parent (clear-context): the engine
        // records it as the new conversation's on-disk parentId. Cleared below.
        ...(tab.pendingParentConversationId ? { parentConversationId: tab.pendingParentConversationId } : {}),
      }
      if (tab.pendingParentConversationId) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, pendingParentConversationId: null } : t
          ),
        }))
      }
      window.ion.engineStart(key, startOpts).then((result) => {
        if (result && !result.ok) {
          rError('engine.session', 'failed to start session', { error: result.error })
          set((state) => {
            const notifications = new Map(state.engineNotifications)
            const keyNotifs = [...(notifications.get(key) || [])]
            keyNotifs.push({ id: nextMsgId(), message: `Extension error: ${result.error}`, level: 'error', timestamp: Date.now() })
            notifications.set(key, keyNotifs)
            const conversationPanes = new Map(state.conversationPanes)
            const paneInner = conversationPanes.get(tabId)
            if (paneInner) {
              const idx = paneInner.instances.findIndex((i) => i.id === 'main')
              if (idx !== -1) {
                const instances = paneInner.instances.slice()
                const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Failed to start engine: ${result.error}`, timestamp: Date.now() }]
                instances[idx] = { ...instances[idx], messages: msgs }
                conversationPanes.set(tabId, { ...paneInner, instances })
              }
            }
            const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
            return { engineNotifications: notifications, conversationPanes, tabs }
          })
          return
        }
        // Capture the engine-minted conversation id at add time so multi-instance
        // extension tabs get a copyable session id immediately (parity with the
        // create path). The engine returns it from start_session before any run.
        if (result?.conversationId) {
          _captureMintedConversationId(set, tabId, result.conversationId)
        }
      }).catch((err: any) => {
        rError('engine.session', 'start threw', { error: err.message })
        set((state) => {
          const conversationPanes = new Map(state.conversationPanes)
          const paneInner = conversationPanes.get(tabId)
          if (paneInner) {
            const idx = paneInner.instances.findIndex((i) => i.id === 'main')
            if (idx !== -1) {
              const instances = paneInner.instances.slice()
              const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Engine start failed: ${err.message}`, timestamp: Date.now() }]
              instances[idx] = { ...instances[idx], messages: msgs }
              conversationPanes.set(tabId, { ...paneInner, instances })
            }
          }
          const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
          return { conversationPanes, tabs }
        })
      })

      return id
    },

    resetEngineInstance: (tabId, instanceId) => {
      const panes = new Map(get().conversationPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      const instanceExists = pane.instances.some((i) => i.id === instanceId)
      if (!instanceExists) return
      const key = tabId
      window.ion.engineAbort(key).catch(() => {})

      const divider = {
        id: nextMsgId(),
        role: 'system' as const,
        content: formatSessionStartDivider(new Date()),
        timestamp: Date.now(),
      }

      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => {
          if (i.id !== instanceId) return i
          return {
            ...i,
            messages: [divider],
            messageCount: 1,
            modelOverride: i.modelOverride,
            sessionModel: null,
            permissionMode: 'auto' as const,
            permissionDenied: null,
            permissionQueue: [],
            elicitationQueue: [],
            conversationIds: [],
            draftInput: '',
            agentStates: [],
            statusFields: null,
            planFilePath: null,
            forkedFromConversationIds: null, dispatchTelemetry: [],
            contextBreakdown: null,
          }
        }),
      })

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

    ...createEngineSubmitActions(set, get),
  }
}
