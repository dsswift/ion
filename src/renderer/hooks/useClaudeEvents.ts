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
export function useClaudeEvents() {
  const handleNormalizedEvent = useSessionStore((s) => s.handleNormalizedEvent)
  const handleStatusChange = useSessionStore((s) => s.handleStatusChange)
  const handleError = useSessionStore((s) => s.handleError)

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
        handleNormalizedEvent(tabId, { type: 'text_chunk', text } as NormalizedEvent)
      }
      buffer.clear()
    }

    const unsubEvent = window.coda.onEvent((tabId, event) => {
      if (event.type === 'text_chunk') {
        // Buffer text chunks and flush on next animation frame
        const buffer = chunkBufferRef.current
        const existing = buffer.get(tabId) || ''
        buffer.set(tabId, existing + (event as any).text)

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(flushChunks)
        }
      } else {
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

    const unsubStatus = window.coda.onTabStatusChange((tabId, newStatus, oldStatus) => {
      handleStatusChange(tabId, newStatus, oldStatus)
    })

    const unsubError = window.coda.onError((tabId, error) => {
      handleError(tabId, error)
    })

    const unsubSkill = window.coda.onSkillStatus((status) => {
      if (status.state === 'failed') {
        console.warn(`[CODA] Skill install failed: ${status.name} — ${status.error}`)
      }
    })

    // Remote user messages (sent from iOS) — submit through the renderer's normal flow
    // so the tab's working directory, session ID, model, and addDirs are used automatically.
    const remoteUserMsgHandler = (_e: any, data: { tabId: string; requestId: string; prompt: string; timestamp: number }) => {
      useSessionStore.getState().submitRemotePrompt(data.tabId, data.prompt)
    }
    window.coda.on(IPC.REMOTE_USER_MESSAGE, remoteUserMsgHandler)

    // Remote bash command (from iOS ! prefix) — execute through the renderer's normal bash flow
    const remoteBashCommandHandler = (_e: any, data: { tabId: string; command: string }) => {
      useSessionStore.getState().submitRemoteBash(data.tabId, data.command)
    }
    window.coda.on(IPC.REMOTE_BASH_COMMAND, remoteBashCommandHandler)

    // Remote permission mode change (from iOS toggle) — update store without calling back to main
    const remoteSetModeHandler = (_e: any, data: { tabId: string; mode: 'auto' | 'plan' }) => {
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === data.tabId ? { ...t, permissionMode: data.mode } : t
        ),
      }))
    }
    window.coda.on(IPC.REMOTE_SET_PERMISSION_MODE, remoteSetModeHandler)

    // Remote close tab (from iOS swipe-to-delete)
    const remoteCloseTabHandler = (_e: any, tabId: string) => {
      const store = useSessionStore.getState()
      const pane = store.terminalPanes.get(tabId)
      if (pane) {
        for (const inst of pane.instances) {
          window.coda.terminalDestroy?.(`${tabId}:${inst.id}`)
        }
      }
      const tabs = store.tabs.filter((t) => t.id !== tabId)
      const panes = new Map(store.terminalPanes)
      panes.delete(tabId)
      const selected = store.selectedTabId === tabId
        ? (tabs[0]?.id ?? null)
        : store.selectedTabId
      useSessionStore.setState({ tabs, terminalPanes: panes, selectedTabId: selected })
    }
    window.coda.on(IPC.REMOTE_CLOSE_TAB, remoteCloseTabHandler)

    // Remote rename tab (from iOS)
    const remoteRenameTabHandler = (_e: any, tabId: string, customTitle: string | null) => {
      useSessionStore.getState().renameTab(tabId, customTitle)
    }
    window.coda.on(IPC.REMOTE_RENAME_TAB, remoteRenameTabHandler)

    // Remote rename terminal instance (from iOS)
    const remoteRenameTermInstHandler = (_e: any, tabId: string, instanceId: string, label: string) => {
      useSessionStore.getState().renameTerminalInstance(tabId, instanceId, label)
    }
    window.coda.on(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, remoteRenameTermInstHandler)

    return () => {
      unsubEvent()
      unsubStatus()
      unsubError()
      unsubSkill()
      window.coda.off(IPC.REMOTE_USER_MESSAGE, remoteUserMsgHandler)
      window.coda.off(IPC.REMOTE_BASH_COMMAND, remoteBashCommandHandler)
      window.coda.off(IPC.REMOTE_SET_PERMISSION_MODE, remoteSetModeHandler)
      window.coda.off(IPC.REMOTE_CLOSE_TAB, remoteCloseTabHandler)
      window.coda.off(IPC.REMOTE_RENAME_TAB, remoteRenameTabHandler)
      window.coda.off(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, remoteRenameTermInstHandler)
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      chunkBufferRef.current.clear()
    }
  }, [handleNormalizedEvent, handleStatusChange, handleError])

  // Note: window.coda.start() is called via sessionStore.initStaticInfo() in App.tsx.
  // No duplicate call needed here.
}
