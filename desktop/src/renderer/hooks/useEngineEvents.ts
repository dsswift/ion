import { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { IPC, type NormalizedEvent, type ImageAttachmentPayload } from '../../shared/types'
import { FORWARDED_ACTIONS } from '../../shared/atv-mirror-actions'
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
  const handleNormalizedEvent = useSessionStore((s) => s.handleNormalizedEvent)
  const handleStatusChange = useSessionStore((s) => s.handleStatusChange)
  const handleError = useSessionStore((s) => s.handleError)

  // RAF batching for text_chunk events
  const chunkBufferRef = useRef<Map<string, string>>(new Map())
  const rafIdRef = useRef<number>(0)

  useEffect(() => {
    // Capture the buffer reference at effect-setup time so the cleanup
    // function uses the same Map instance (refs can change between setup and
    // cleanup per the react-hooks/exhaustive-deps rule).
    const chunkBuffer = chunkBufferRef.current
    const flushChunks = () => {
      rafIdRef.current = 0
      const buffer = chunkBufferRef.current
      if (buffer.size === 0) return

      // Flush all accumulated text per tab in one go
      for (const [tabId, text] of buffer) {
        rTrace('event.stream', 'flushing text_chunk', { tab_id: tabId, flush_len: text.length })
        handleNormalizedEvent(tabId, { type: 'text_chunk', text } as NormalizedEvent)
      }
      buffer.clear()
    }

    rDebug('event.stream', 'registering onEvent handler')
    const unsubEvent = window.ion.onEvent((tabId, event) => {
      if (event.type === 'text_chunk') {
        // Buffer text chunks and flush on next animation frame
        const buffer = chunkBufferRef.current
        const existing = buffer.get(tabId) || ''
        buffer.set(tabId, existing + (event as any).text)
        rTrace('event.stream', 'text_chunk buffered', { tab_id: tabId, chunk_len: (event as any).text?.length, buffer_len: buffer.get(tabId)?.length })

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(flushChunks)
        }
      } else {
        // stream_reset: engine is retrying — discard any buffered text for this
        // tab so it doesn't get flushed after the reset clears the store.
        if (event.type === 'stream_reset') {
          chunkBufferRef.current.delete(tabId)
          if (rafIdRef.current && chunkBufferRef.current.size === 0) {
            cancelAnimationFrame(rafIdRef.current)
            rafIdRef.current = 0
          }
        }
        // task_update and task_complete contain fallback text logic that checks
        // whether any assistant text has already been rendered. If a RAF flush is
        // pending, those checks would see stale state and incorrectly conclude
        // "no text yet" — causing duplicate messages once the RAF fires.
        // Flush synchronously before handling these events so the store sees the
        // correct message state.
        if (
          (event.type === 'task_update' || event.type === 'task_complete') &&
          rafIdRef.current
        ) {
          cancelAnimationFrame(rafIdRef.current)
          flushChunks()
        }
        handleNormalizedEvent(tabId, event)
      }
    })

    const unsubStatus = window.ion.onTabStatusChange((tabId, newStatus, oldStatus) => {
      handleStatusChange(tabId, newStatus, oldStatus)
    })

    const unsubError = window.ion.onError((tabId, error) => {
      handleError(tabId, error)
    })

    const unsubSkill = window.ion.onSkillStatus((status) => {
      if (status.state === 'failed') {
        rWarn('event.skill', 'skill install failed', { name: status.name, error: status.error })
      }
    })

    // Remote user messages (sent from iOS) — submit through the renderer's normal flow
    // so the tab's working directory, session ID, model, and addDirs are used automatically.
    const remoteUserMsgHandler = (_e: any, data: { tabId: string; requestId: string; prompt: string; timestamp: number; imageAttachments?: ImageAttachmentPayload[]; resolveSlash?: boolean }) => {
      useSessionStore.getState().submitRemotePrompt(data.tabId, data.prompt, data.imageAttachments, data.resolveSlash)
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
    const remoteSetThinkingHandler = (_e: any, data: { tabId: string; effort: 'off' | 'low' | 'medium' | 'high' }) => {
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

    // Remote close tab (from iOS swipe-to-delete)
    const remoteCloseTabHandler = (_e: any, tabId: string) => {
      const store = useSessionStore.getState()
      const pane = store.terminalPanes.get(tabId)
      if (pane) {
        for (const inst of pane.instances) {
          window.ion.terminalDestroy?.(`${tabId}:${inst.id}`)
        }
      }
      const tabs = store.tabs.filter((t) => t.id !== tabId)
      const panes = new Map(store.terminalPanes)
      panes.delete(tabId)
      const selected = store.activeTabId === tabId
        ? (tabs[0]?.id ?? null)
        : store.activeTabId
      useSessionStore.setState({ tabs, terminalPanes: panes, activeTabId: selected })
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
    const remoteEnginePromptHandler = (_e: any, data: { tabId: string; text: string; appendSystemPrompt?: string; imageAttachments?: ImageAttachmentPayload[]; attachments?: Array<{ type: string; name: string; path: string }>; resolveSlash?: boolean }) => {
      useSessionStore.getState().submit(data.tabId, data.text, { appendSystemPrompt: data.appendSystemPrompt, imageAttachments: data.imageAttachments, remoteAttachments: data.attachments, source: 'remote', resolveSlash: data.resolveSlash })
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

    // Forwarded actions from the ATV mirror window: this renderer is the
    // session-store OWNER, so owner-durable mutations execute here (main
    // already validated the action against FORWARDED_ACTIONS). The resulting
    // state flows back to the mirror via events and sync pushes.
    const unsubExecAction = window.ion.onAtvExecAction((action, args) => {
      if (!(action in FORWARDED_ACTIONS)) {
        rWarn('event.atv', 'exec-action outside the forwarded set', { action })
        return
      }
      const store = useSessionStore.getState() as unknown as Record<string, unknown>
      const fn = store[action]
      if (typeof fn !== 'function') {
        rWarn('event.atv', 'exec-action has no store implementation', { action })
        return
      }
      rDebug('event.atv', 'executing forwarded action', { action, arg_count: args.length })
      void (fn as (...a: unknown[]) => unknown)(...args)
    })

    return () => {
    rDebug('event.stream', 'cleanup: removing handlers')
      unsubEvent()
      unsubStatus()
      unsubError()
      unsubSkill()
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
      chunkBuffer.clear()
    }
  }, [handleNormalizedEvent, handleStatusChange, handleError])

  // Note: window.ion.start() is called via sessionStore.initStaticInfo() in App.tsx.
  // No duplicate call needed here.
}
