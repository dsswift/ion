import { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { IPC, type NormalizedEvent } from '../../shared/types'

/**
 * Subscribes to all ControlPlane events via IPC and routes them
 * to the Zustand store.
 *
 * text_chunk events are batched per animation frame to avoid
 * flooding React with one state update per chunk during streaming.
 */
export function useEngineEvents() {
  const handleNormalizedEvent = useSessionStore((s) => s.handleNormalizedEvent)
  const handleStatusChange = useSessionStore((s) => s.handleStatusChange)
  const handleError = useSessionStore((s) => s.handleError)
  const handleEngineEvent = useSessionStore((s) => s.handleEngineEvent)

  // RAF batching for text_chunk events
  const chunkBufferRef = useRef<Map<string, string>>(new Map())
  const rafIdRef = useRef<number>(0)

  useEffect(() => {
    const flushChunks = () => {
      rafIdRef.current = 0
      const buffer = chunkBufferRef.current
      if (buffer.size === 0) return

      // Flush all accumulated text per tab in one go
      for (const [tabId, text] of buffer) {
        console.log(`[DIAG] flushing text_chunk: tab=${tabId} flush_len=${text.length}`)
        handleNormalizedEvent(tabId, { type: 'text_chunk', text } as NormalizedEvent)
      }
      buffer.clear()
    }

    console.log('[DIAG] useEngineEvents: registering onEvent handler')
    const unsubEvent = window.ion.onEvent((tabId, event) => {
      if (event.type === 'text_chunk') {
        // Buffer text chunks and flush on next animation frame
        const buffer = chunkBufferRef.current
        const existing = buffer.get(tabId) || ''
        buffer.set(tabId, existing + (event as any).text)
        console.log(`[DIAG] text_chunk buffered: tab=${tabId} chunk_len=${(event as any).text?.length} buffer_len=${buffer.get(tabId)?.length}`)

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
        console.warn(`[Ion] Skill install failed: ${status.name} — ${status.error}`)
      }
    })

    // Engine tab events (status, agent state, text deltas, etc.)
    const unsubEngineEvent = window.ion.onEngineEvent((key, event) => {
      handleEngineEvent(key, event)
    })

    // Remote user messages (sent from iOS) — submit through the renderer's normal flow
    // so the tab's working directory, session ID, model, and addDirs are used automatically.
    const remoteUserMsgHandler = (_e: any, data: { tabId: string; requestId: string; prompt: string; timestamp: number }) => {
      useSessionStore.getState().submitRemotePrompt(data.tabId, data.prompt)
    }
    window.ion.on(IPC.REMOTE_USER_MESSAGE, remoteUserMsgHandler)

    // Remote bash command (from iOS ! prefix) — execute through the renderer's normal bash flow
    const remoteBashCommandHandler = (_e: any, data: { tabId: string; command: string }) => {
      useSessionStore.getState().submitRemoteBash(data.tabId, data.command)
    }
    window.ion.on(IPC.REMOTE_BASH_COMMAND, remoteBashCommandHandler)

    // Remote permission mode change (from iOS toggle) — update store without calling back to main
    const remoteSetModeHandler = (_e: any, data: { tabId: string; mode: 'auto' | 'plan' }) => {
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === data.tabId ? { ...t, permissionMode: data.mode } : t
        ),
      }))
    }
    window.ion.on(IPC.REMOTE_SET_PERMISSION_MODE, remoteSetModeHandler)

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

    return () => {
      console.log('[DIAG] useEngineEvents: cleanup — removing handlers')
      unsubEvent()
      unsubStatus()
      unsubError()
      unsubSkill()
      unsubEngineEvent()
      window.ion.off(IPC.REMOTE_USER_MESSAGE, remoteUserMsgHandler)
      window.ion.off(IPC.REMOTE_BASH_COMMAND, remoteBashCommandHandler)
      window.ion.off(IPC.REMOTE_SET_PERMISSION_MODE, remoteSetModeHandler)
      window.ion.off(IPC.REMOTE_CLOSE_TAB, remoteCloseTabHandler)
      window.ion.off(IPC.REMOTE_RENAME_TAB, remoteRenameTabHandler)
      window.ion.off(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, remoteRenameTermInstHandler)
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      chunkBufferRef.current.clear()
    }
  }, [handleNormalizedEvent, handleStatusChange, handleError, handleEngineEvent])

  // Note: window.ion.start() is called via sessionStore.initStaticInfo() in App.tsx.
  // No duplicate call needed here.
}
