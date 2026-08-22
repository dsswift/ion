import { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { IPC, type ImageAttachmentPayload } from '../../shared/types'
import {
  type QueuedItem, enqueueEvent, enqueueStatus, enqueueError, dropQueuedTextFor, countMergedChunks,
} from './engine-event-frame-queue'
import { FORWARDED_ACTIONS } from '../../shared/studio-mirror-actions'
import { isMirrorWindow } from '../lib/window-role'
import { rTrace, rWarn, rDebug } from '../rendererLogger'

/**
 * Subscribes to the single normalized-event stream (ion:normalized-event) and
 * routes events to the Zustand store via handleNormalizedEvent.
 *
 * WI-001 (single-path collapse): the raw IPC.ENGINE_EVENT subscription
 * (the second raw stream) has been retired. Every conversation — plain and
 * extension-hosted — flows exclusively through the normalized stream.
 * The engine-control-plane translates all engine_* signals to NormalizedEvent
 * variants before broadcasting; the renderer never touches raw engine events.
 *
 * text_chunk events are batched per animation frame to avoid flooding React
 * with one state update per chunk during streaming.
 */
export function useEngineEvents() {
  useEffect(() => {
    let live = true
    const seenActivity = new Set<string>()
    void window.ion.terminalActiveTabs()
      .then((tabIds) => {
        if (!live) return
        useSessionStore.setState((s) => {
          // Activity events can arrive before this asynchronous snapshot. Keep
          // those newer observations instead of letting an old snapshot erase
          // live tab activity.
          const terminalActiveTabIds = new Set(tabIds)
          for (const tabId of seenActivity) {
            if (s.terminalActiveTabIds.has(tabId)) terminalActiveTabIds.add(tabId)
            else terminalActiveTabIds.delete(tabId)
          }
          return { terminalActiveTabIds }
        })
      })
      .catch((err) => rWarn('terminal', 'active terminal snapshot failed', { error: String(err) }))
    const unsubscribe = window.ion.onTerminalActivity(({ tabId, active }) => {
      seenActivity.add(tabId)
      useSessionStore.setState((s) => {
        const terminalActiveTabIds = new Set(s.terminalActiveTabIds)
        if (active) terminalActiveTabIds.add(tabId)
        else terminalActiveTabIds.delete(tabId)
        return { terminalActiveTabIds }
      })
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  const handleNormalizedEvent = useSessionStore((s) => s.handleNormalizedEvent)
  const handleStatusChange = useSessionStore((s) => s.handleStatusChange)
  const handleError = useSessionStore((s) => s.handleError)

  // One frame's worth of inbound stream work, replayed in arrival order.
  const queueRef = useRef<QueuedItem[]>([])
  const rafIdRef = useRef<number>(0)

  useEffect(() => {
    // Counters for one frame, reported at flush so the stream's real inbound
    // rate and the coalescing ratio are visible in desktop.jsonl without a
    // debugger (the renderer console is unavailable in a packaged build).
    let received = 0

    const flush = () => {
      rafIdRef.current = 0
      const items = queueRef.current
      if (items.length === 0) {
        received = 0
        return
      }
      queueRef.current = []

      const merged = countMergedChunks(received, items)
      rTrace('event.stream', 'frame flush', {
        received, applied: items.length, merged_chunks: merged,
      })
      received = 0

      for (const item of items) {
        switch (item.kind) {
          case 'event':
            handleNormalizedEvent(item.tabId, item.event)
            break
          case 'status':
            handleStatusChange(item.tabId, item.status, item.previous)
            break
          case 'error':
            handleError(item.tabId, item.error)
            break
        }
      }
    }

    const schedule = () => {
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(flush)
      }
    }

    rDebug('event.stream', 'registering onEvent handler')
    const unsubEvent = window.ion.onEvent((tabId, event) => {
      received += 1
      // stream_reset: the engine is retrying — text queued behind the reset
      // would be appended after the reset cleared it, so drop it now.
      if (event.type === 'stream_reset') {
        queueRef.current = dropQueuedTextFor(queueRef.current, tabId)
      }
      enqueueEvent(queueRef.current, tabId, event)
      schedule()
    })

    const unsubStatus = window.ion.onTabStatusChange((tabId, newStatus, oldStatus) => {
      // Queued rather than applied directly: a status transition and the event
      // that caused it arrive on different IPC channels, and applying one
      // ahead of the other would show a status the conversation had not
      // reached yet.
      enqueueStatus(queueRef.current, tabId, newStatus, oldStatus)
      schedule()
    })

    const unsubError = window.ion.onError((tabId, error) => {
      enqueueError(queueRef.current, tabId, error)
      schedule()
    })

    const unsubSkill = window.ion.onSkillStatus((status) => {
      if (status.state === 'failed') {
        rWarn('event.skill', 'skill install failed', { name: status.name, error: status.error })
      }
    })

    // Engine came back after an outage: re-arm history hydration for panes
    // whose load failed while it was down. Mirror-local (each window
    // re-hydrates its own store), same as loadSkeletonMessages.
    const engineReconnectedHandler = () => {
      useSessionStore.getState().rehydrateFailedHistory()
    }
    window.ion.on('ion:engine-reconnected', engineReconnectedHandler)

    // Remote user messages (sent from iOS) — submit through the renderer's normal flow
    // so the tab's working directory, session ID, model, and addDirs are used automatically.
    // `attachments` is the raw iOS attachment metadata (type/name/path) the pipeline
    // forwards so the optimistic user message renders inline image previews — the
    // rewritten prompt only carries the pathless "(content attached)" marker form.
    const remoteUserMsgHandler = (_e: any, data: { tabId: string; requestId: string; prompt: string; timestamp: number; imageAttachments?: ImageAttachmentPayload[]; attachments?: Array<{ type: string; name: string; path: string; contentHash?: string }>; resolveSlash?: boolean }) => {
      useSessionStore.getState().submitRemotePrompt(data.tabId, data.prompt, data.imageAttachments, data.resolveSlash, data.attachments, data.requestId)
    }
    window.ion.on(IPC.REMOTE_USER_MESSAGE, remoteUserMsgHandler)

    // Remote bash command (from iOS ! prefix) — execute through the renderer's normal bash flow
    const remoteBashCommandHandler = (_e: any, data: { tabId: string; command: string }) => {
      useSessionStore.getState().submitRemoteBash(data.tabId, data.command)
    }
    window.ion.on(IPC.REMOTE_BASH_COMMAND, remoteBashCommandHandler)

    // Remote permission mode change (from iOS toggle or slash-command expansion).
    // WI-001: all tab types write permissionMode onto the active instance in
    // conversationPanes. The parent tab.permissionMode is no longer written here.
    const remoteSetModeHandler = (_e: any, data: { tabId: string; mode: 'auto' | 'plan' }) => {
      useSessionStore.setState((s) => {
        const conversationPanes = new Map(s.conversationPanes)
        const pane = conversationPanes.get(data.tabId)
        if (!pane) return {}
        const instanceId = pane.activeInstanceId
        if (!instanceId) return {}
        const idx = pane.instances.findIndex((i) => i.id === instanceId)
        if (idx === -1) return {}
        const instances = pane.instances.slice()
        instances[idx] = { ...instances[idx], permissionMode: data.mode }
        conversationPanes.set(data.tabId, { ...pane, instances })
        return { conversationPanes }
      })

      // Re-evaluate auto group movement after the mode change
      const { autoGroupMovement, tabGroupMode, planningGroupId, inProgressGroupId } = usePreferencesStore.getState()
      if (autoGroupMovement && tabGroupMode === 'manual') {
        const tab = useSessionStore.getState().tabs.find((t) => t.id === data.tabId)
        if (tab) {
          if (tab.groupPinned) {
            const wouldMoveTo = data.mode === 'plan' ? planningGroupId : inProgressGroupId
            rDebug('auto-move', 'suppressed: tab pinned', { tab_id: data.tabId.slice(0, 8), current_group: tab.groupId ?? '', would_move_to: wouldMoveTo ?? '' })
          } else if (data.mode === 'plan' && planningGroupId && tab.groupId !== planningGroupId) {
            useSessionStore.getState().moveTabToGroup(data.tabId, planningGroupId)
          } else if (data.mode === 'auto' && inProgressGroupId && tab.groupId !== inProgressGroupId) {
            useSessionStore.getState().moveTabToGroup(data.tabId, inProgressGroupId)
          }
        }
      }
    }
    window.ion.on(IPC.REMOTE_SET_PERMISSION_MODE, remoteSetModeHandler)

    // Remote thinking-effort change (from iOS).
    // WI-001: write thinkingEffort onto the active instance for all tab types.
    const remoteSetThinkingHandler = (_e: any, data: { tabId: string; effort: 'off' | 'adaptive' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }) => {
      useSessionStore.setState((s) => {
        const conversationPanes = new Map(s.conversationPanes)
        const pane = conversationPanes.get(data.tabId)
        if (!pane?.activeInstanceId) return {}
        const idx = pane.instances.findIndex((i) => i.id === pane.activeInstanceId)
        if (idx === -1) return {}
        const instances = pane.instances.slice()
        instances[idx] = { ...instances[idx], thinkingEffort: data.effort }
        conversationPanes.set(data.tabId, { ...pane, instances })
        return { conversationPanes }
      })
    }
    window.ion.on(IPC.REMOTE_SET_THINKING_EFFORT, remoteSetThinkingHandler)

    // Direct main-process fallback already stopped the remote tab's sessions and
    // broadcast its permanent removal. Only overlay owns durable tab state;
    // Studio follows owner sync.
    const remoteCloseTabHandler = (_e: any, tabId: string) => {
      if (isMirrorWindow()) {
        rDebug('remote.close-tab', 'mirror ignored remote close; awaiting owner sync', { tab_id: tabId })
        return
      }
      useSessionStore.getState().closeTab(tabId, 'remote-delete')
    }
    window.ion.on(IPC.REMOTE_CLOSE_TAB, remoteCloseTabHandler)

    // Remote rename tab (from iOS)
    const remoteRenameTabHandler = (_e: any, tabId: string, customTitle: string | null) => {
      useSessionStore.getState().renameTab(tabId, customTitle)
    }
    window.ion.on(IPC.REMOTE_RENAME_TAB, remoteRenameTabHandler)

    // Remote rename terminal instance (from iOS)
    const remoteRenameTermInstHandler = (_e: any, tabId: string, instanceId: string, label: string) => {
      useSessionStore.getState().renameTerminalInstance(tabId, instanceId, label)
    }
    window.ion.on(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, remoteRenameTermInstHandler)

    // Remote engine prompt (sent from iOS) — submit through the renderer's
    // unified submit so the store adds the user message, sets status, resolves
    // the tab's extensions (data) and dispatches the prompt. There is no
    // separate engine submit path any more. source='remote' ensures the
    // IPC.PROMPT handler skips its redundant desktop_message_added echo — the
    // canonical echo was already sent by tabs-prompt.ts; a second echo with a
    // renderer-generated id would cause a duplicate user bubble on iOS.
    const remoteEnginePromptHandler = (_e: any, data: { tabId: string; text: string; reqId?: string; appendSystemPrompt?: string; imageAttachments?: ImageAttachmentPayload[]; attachments?: Array<{ type: string; name: string; path: string; contentHash?: string }>; resolveSlash?: boolean }) => {
      useSessionStore.getState().submit(data.tabId, data.text, { appendSystemPrompt: data.appendSystemPrompt, imageAttachments: data.imageAttachments, remoteAttachments: data.attachments, source: 'remote', resolveSlash: data.resolveSlash, requestId: data.reqId })
    }
    window.ion.on(IPC.REMOTE_ENGINE_PROMPT, remoteEnginePromptHandler)

    // Remote set pill color (from iOS)
    const remoteSetPillColorHandler = (_e: any, tabId: string, color: string | null) => {
      useSessionStore.getState().setTabPillColor(tabId, color)
    }
    window.ion.on(IPC.REMOTE_SET_PILL_COLOR, remoteSetPillColorHandler)

    // Remote set pill icon (from iOS)
    const remoteSetPillIconHandler = (_e: any, tabId: string, icon: string | null) => {
      useSessionStore.getState().setTabPillIcon(tabId, icon)
    }
    window.ion.on(IPC.REMOTE_SET_PILL_ICON, remoteSetPillIconHandler)

    // Forwarded actions from the Studio mirror window: this renderer is the
    // session-store OWNER, so owner-durable mutations execute here (main
    // already validated the action against FORWARDED_ACTIONS). The resulting
    // state flows back to the mirror via events and sync pushes.
    const unsubExecAction = window.ion.onStudioExecAction((action, args, callId) => {
      // A round-trip call (callId set) must ALWAYS get exactly one reply, on
      // every path — including the two rejections below. A mirror caller is
      // awaiting it, and main only unblocks them on a reply or a timeout, so a
      // silent return here would cost them 30s of hang for a fault we already
      // know about right now.
      const reply = (value: unknown): void => {
        if (callId) window.ion.studioActionResult(callId, value)
      }
      if (!(action in FORWARDED_ACTIONS)) {
        rWarn('event.studio', 'exec-action outside the forwarded set', { action })
        reply(undefined)
        return
      }
      const store = useSessionStore.getState() as unknown as Record<string, unknown>
      const fn = store[action]
      if (typeof fn !== 'function') {
        rWarn('event.studio', 'exec-action has no store implementation', { action })
        reply(undefined)
        return
      }
      rDebug('event.studio', 'executing forwarded action', {
        action, arg_count: args.length, call_id: callId ?? '',
      })
      // Fire-and-forget (no callId) keeps its existing `void` shape. A round
      // trip resolves the action and returns its value — including a rejection,
      // which becomes `undefined` rather than an unhandled rejection here: the
      // owner logs the throw, and the mirror sees "no value", which is the same
      // shape a non-returning action produces.
      const ret = (fn as (...a: unknown[]) => unknown)(...args)
      if (!callId) {
        void ret
        return
      }
      Promise.resolve(ret)
        .then((value) => reply(value))
        .catch((err) => {
          rWarn('event.studio', 'forwarded action threw; replying with no value', {
            action, call_id: callId, error: String(err),
          })
          reply(undefined)
        })
    })

    return () => {
    rDebug('event.stream', 'cleanup: removing handlers')
      unsubEvent()
      unsubStatus()
      unsubError()
      unsubSkill()
      window.ion.off('ion:engine-reconnected', engineReconnectedHandler)
      window.ion.off(IPC.REMOTE_USER_MESSAGE, remoteUserMsgHandler)
      window.ion.off(IPC.REMOTE_BASH_COMMAND, remoteBashCommandHandler)
      window.ion.off(IPC.REMOTE_SET_PERMISSION_MODE, remoteSetModeHandler)
      window.ion.off(IPC.REMOTE_SET_THINKING_EFFORT, remoteSetThinkingHandler)
      window.ion.off(IPC.REMOTE_CLOSE_TAB, remoteCloseTabHandler)
      window.ion.off(IPC.REMOTE_RENAME_TAB, remoteRenameTabHandler)
      window.ion.off(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, remoteRenameTermInstHandler)
      window.ion.off(IPC.REMOTE_ENGINE_PROMPT, remoteEnginePromptHandler)
      window.ion.off(IPC.REMOTE_SET_PILL_COLOR, remoteSetPillColorHandler)
      window.ion.off(IPC.REMOTE_SET_PILL_ICON, remoteSetPillIconHandler)
      unsubExecAction()
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      queueRef.current = []
    }
  }, [handleNormalizedEvent, handleStatusChange, handleError])

  // Note: window.ion.start() is called via sessionStore.initStaticInfo() in App.tsx.
  // No duplicate call needed here.
}
