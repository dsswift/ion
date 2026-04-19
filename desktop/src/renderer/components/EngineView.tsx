import React, { useEffect, useRef, useState, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { EngineDialog } from './EngineDialog'
import { EngineStatusBar } from './EngineStatusBar'
import { OvalOffice } from './OvalOffice'
import { EngineFooter } from './EngineFooter'
import {
  groupMessages,
  ToolGroup, AssistantMessage, SystemMessage, MessageBubble,
  CopyButton, InterruptButton,
} from './conversation'

// ─── Main Component ───

interface EngineViewProps {
  tabId: string
}

export function EngineView({ tabId }: EngineViewProps) {
  const colors = useColors()
  const pane = useSessionStore(s => s.enginePanes.get(tabId))
  const activeInstanceId = pane?.activeInstanceId || ''
  const key = activeInstanceId ? `${tabId}:${activeInstanceId}` : ''

  const pinnedPrompt = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.enginePinnedPrompt.get(k) || '') : ''
  })
  const notifications = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.engineNotifications.get(k) || []) : []
  })
  const messages = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.engineMessages.get(k) || []) : []
  })
  const agentStates = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.engineAgentStates.get(k) || []) : []
  })
  const statusFields = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.engineStatusFields.get(k) || null) : null
  })
  const workingMessage = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.engineWorkingMessages.get(k) || '') : ''
  })
  const tabStatus = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.status)
  const isTall = useSessionStore(s => s.tallViewTabId === tabId)
  const toggleTallView = useSessionStore(s => s.toggleTallView)
  const isRunning = tabStatus === 'running' || tabStatus === 'connecting'
  const scrollRef = useRef<HTMLDivElement>(null)

  // Include all messages (user messages shown inline, plus pinned prompt header)
  const visibleMessages = messages
  const grouped = useMemo(() => groupMessages(visibleMessages, { includeUser: true }), [visibleMessages])

  const hasContent = visibleMessages.some(m => m.role === 'assistant' && m.content.length > 0)
  const showThinking = isRunning && !hasContent && agentStates.filter(a => a.status === 'running').length === 0

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, visibleMessages.length, agentStates.length, workingMessage, isRunning])

  // Auto-create first instance
  useEffect(() => {
    const pane = useSessionStore.getState().enginePanes.get(tabId)
    if (!pane || pane.instances.length === 0) {
      useSessionStore.getState().addEngineInstance(tabId)
    }
  }, [tabId])

  // Auto-dismiss notifications after 5s
  useEffect(() => {
    if (notifications.length === 0) return
    const timer = setTimeout(() => {
      useSessionStore.setState(state => {
        const p = state.enginePanes.get(tabId)
        const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
        if (!k) return {}
        const notifs = new Map(state.engineNotifications)
        const keyNotifs = notifs.get(k) || []
        if (keyNotifs.length > 0) {
          notifs.set(k, keyNotifs.slice(1))
        }
        return { engineNotifications: notifs }
      })
    }, 5000)
    return () => clearTimeout(timer)
  }, [notifications.length, tabId])

  // No instances placeholder
  if (!pane || pane.instances.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        alignItems: 'center', justifyContent: 'center',
        color: colors.textTertiary, fontSize: 13,
      }}>
        Session not started
      </div>
    )
  }

  const handleAbort = () => {
    if (key) window.ion.engineAbort(key)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <EngineStatusBar tabId={tabId} />

      {/* Pinned prompt header */}
      {pinnedPrompt && (
        <div
          style={{
            padding: '8px 12px',
            borderBottom: `1px solid ${colors.containerBorder}`,
            fontSize: 13,
            color: colors.textSecondary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <span style={{ color: colors.accent, fontWeight: 600 }}>{' > '}</span>
          {pinnedPrompt}
        </div>
      )}

      {/* Scrollable conversation area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto', padding: '8px 12px' }}>
          {/* Thinking indicator */}
          <AnimatePresence>
            {showThinking && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 0',
                  fontSize: 12,
                  color: colors.textTertiary,
                }}
              >
                <span
                  className="animate-pulse-dot"
                  style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: colors.accent, display: 'inline-block',
                  }}
                />
                <span>Thinking...</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Grouped conversation messages */}
          {grouped.length > 0 && (
            <div style={{ paddingTop: 4 }}>
              {grouped.map((item, idx) => {
                switch (item.kind) {
                  case 'user':
                    return <MessageBubble key={item.message.id} message={item.message} skipMotion actions={<CopyButton text={item.message.content} />} />
                  case 'assistant':
                    return <AssistantMessage key={item.message.id} message={item.message} skipMotion />
                  case 'tool-group':
                    return <ToolGroup key={`tg-${idx}`} tools={item.messages} skipMotion />
                  case 'system':
                    return <SystemMessage key={item.message.id} message={item.message} skipMotion />
                  default:
                    return null
                }
              })}
            </div>
          )}

          {/* Working message */}
          {workingMessage && (
            <div style={{
              padding: '6px 0', fontSize: 12,
              color: colors.textTertiary, fontStyle: 'italic',
            }}>
              {workingMessage}
            </div>
          )}

          {/* Streaming indicator */}
          {isRunning && hasContent && (
            <div style={{ padding: '4px 0' }}>
              <span
                className="animate-pulse-dot"
                style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: colors.accent, display: 'inline-block',
                }}
              />
            </div>
          )}
        </div>

        {/* Interrupt button */}
        <AnimatePresence>
          {isRunning && messages.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: 4, right: 12,
              zIndex: 2,
            }}>
              <InterruptButton onInterrupt={handleAbort} />
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Agent bars */}
      <OvalOffice agents={agentStates} />

      {/* Status footer */}
      <EngineFooter
        status={statusFields}
        isTall={isTall}
        onToggleTall={() => toggleTallView(tabId)}
      />

      {/* Notification toasts */}
      <AnimatePresence>
        {notifications.slice(0, 3).map((notif) => (
          <motion.div
            key={notif.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            style={{
              position: 'absolute',
              bottom: 32, right: 12,
              maxWidth: 300,
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 12,
              background: notif.level === 'error' ? 'rgba(200,50,50,0.9)' :
                notif.level === 'warning' ? 'rgba(180,140,30,0.9)' :
                  'rgba(60,60,55,0.95)',
              color: '#fff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
          >
            {notif.message}
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Dialog overlay */}
      <EngineDialog tabId={tabId} />
    </div>
  )
}
