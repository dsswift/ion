import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { meta, isAgentVisible, sortAgents, getLabelBg, getStatusSuffix, getDispatches, sliceMessagesForDispatch } from './agent-panel-helpers'
import { AgentExpandedView } from './AgentExpandedView'
import { AgentDetailPanel } from './AgentDetailPanel'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'

const DEFAULT_PANEL_HEIGHT = 200
const MIN_PANEL_HEIGHT = 80
const MAX_PANEL_PCT = 0.8

interface Props {
  agents: AgentStateUpdate[]
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  /** Custom panel height in pixels (rows container). Undefined = default. */
  panelHeight?: number
  /** Called when the user drags the resize handle to a new height. */
  onPanelHeightChange?: (height: number) => void
}

export function AgentPanel({ agents, isFullscreen, onToggleFullscreen, panelHeight, onPanelHeightChange }: Props) {
  const colors = useColors()
  const agentPanelDefaultOpen = usePreferencesStore((s) => s.agentPanelDefaultOpen)
  const agentDetailPopup = usePreferencesStore((s) => s.agentDetailPopup)
  const [agentExpanded, setAgentExpanded] = useState<Map<string, boolean>>(new Map())
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  // Keyed by conversationId — each dispatch's conversation is loaded independently
  const [convMessages, setConvMessages] = useState<Map<string, Message[]>>(new Map())
  const [convLoading, setConvLoading] = useState<Map<string, boolean>>(new Map())
  // Track which dispatch index is selected per agent name
  const [selectedDispatch, setSelectedDispatch] = useState<Map<string, number>>(new Map())
  // Popup state — which agent (by name) is shown in the floating detail panel
  const [popupAgentName, setPopupAgentName] = useState<string | null>(null)
  const prevVisibleCount = useRef(0)
  // Tracks whether the user manually toggled the panel this "session"
  // (since agents last appeared). Reset when agents go from 0→N so the
  // default-open preference drives the initial state on each fresh batch.
  const userToggled = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const visible = sortAgents(agents.filter(isAgentVisible))

  // When agents transition from none→some, apply the user's default
  // preference (open or collapsed). When they go back to none, reset
  // the manual-toggle flag so the next batch gets the preference again.
  useEffect(() => {
    if (prevVisibleCount.current === 0 && visible.length > 0) {
      // Fresh batch of agents appeared — apply the default preference
      // unless the user already manually toggled this mount.
      if (!userToggled.current) {
        setPanelCollapsed(!agentPanelDefaultOpen)
      }
    }
    if (visible.length === 0) {
      // All agents gone — reset so the next batch gets the default.
      userToggled.current = false
    }
    prevVisibleCount.current = visible.length
  }, [visible.length, agentPanelDefaultOpen])

  const loadSingleConversation = useCallback(async (convId: string) => {
    if (!convId || convMessages.has(convId)) return
    setConvLoading(prev => { const next = new Map(prev); next.set(convId, true); return next })
    try {
      console.log(`[AgentPanel] fetching conversation: convId=${convId}`)
      const data = await window.ion.getConversation(convId, 0, 200)
      const msgs: Message[] = (data.messages || []).map((m: any, i: number) => ({
        id: `${convId.slice(0, 8)}-${i}`,
        role: m.role,
        content: m.content,
        toolName: m.toolName || '',
        toolInput: m.toolInput || '',
        toolStatus: 'completed' as const,
        timestamp: m.timestamp || 0,
      }))
      console.log(`[AgentPanel] loaded ${msgs.length} messages for convId=${convId}`)
      setConvMessages(prev => { const next = new Map(prev); next.set(convId, msgs); return next })
    } catch (err) {
      console.error(`[AgentPanel] loadConversation error:`, err)
    } finally {
      setConvLoading(prev => { const next = new Map(prev); next.set(convId, false); return next })
    }
  }, [convMessages])

  /** Load the conversation for the selected dispatch of an agent,
   *  then lazily preload the remaining dispatches in the background. */
  const loadAgentDispatch = useCallback((agent: AgentStateUpdate) => {
    const dispatches = getDispatches(agent)
    if (dispatches.length === 0) return
    const idx = selectedDispatch.get(agent.name) ?? dispatches.length - 1
    const convId = dispatches[idx]?.conversationId
    if (convId) {
      // Load the selected dispatch first, then preload the rest.
      loadSingleConversation(convId).then(() => {
        for (const d of dispatches) {
          if (d.conversationId && d.conversationId !== convId) {
            loadSingleConversation(d.conversationId)
          }
        }
      })
    }
  }, [selectedDispatch, loadSingleConversation])

  // Re-fetch conversation when an expanded agent transitions to a terminal state
  // or when its conversationIds change (new dispatch completed). This handles
  // the case where a user expands a running agent (no conversationId yet), then
  // the agent completes — and also re-fetches when a second dispatch adds a new
  // conversation ID to the accumulated list.
  useEffect(() => {
    for (const agent of visible) {
      const isExpanded = agentExpanded.get(agent.name)
      const isTerminal = agent.status === 'done' || agent.status === 'error'
      const hasAnyConvId = getDispatches(agent).some(d => d.conversationId)
      if (isExpanded && isTerminal && hasAnyConvId) {
        loadAgentDispatch(agent)
      }
    }
  }, [visible, agentExpanded, loadAgentDispatch])

  // Auto-close popup when the agent disappears from the visible set
  useEffect(() => {
    if (popupAgentName && !visible.find(a => a.name === popupAgentName)) {
      setPopupAgentName(null)
    }
  }, [visible, popupAgentName])

  // Live streaming for popup — re-fetch when dispatch signature changes
  const popupAgent = popupAgentName ? visible.find(a => a.name === popupAgentName) : null
  const popupDispatchSig = popupAgent
    ? `${getDispatches(popupAgent).map(d => d.conversationId).join(',')}|${popupAgent.status}|${getDispatches(popupAgent).length}`
    : ''
  useEffect(() => {
    if (popupAgent) loadAgentDispatch(popupAgent)
  }, [popupDispatchSig]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Check if any conversation is currently loading for an agent. */
  const isAgentLoading = useCallback((agent: AgentStateUpdate): boolean => {
    const dispatches = getDispatches(agent)
    return dispatches.some(d => d.conversationId && convLoading.get(d.conversationId))
  }, [convLoading])

  /** Resolve dispatch data for a given agent (used by both inline and popup). */
  const resolveDispatchData = useCallback((agent: AgentStateUpdate) => {
    const dispatches = getDispatches(agent)
    const dispIdx = selectedDispatch.get(agent.name) ?? dispatches.length - 1
    const activeConvId = dispatches[dispIdx]?.conversationId || ''
    const rawMsgs = activeConvId ? convMessages.get(activeConvId) : undefined
    const activeDispatch = dispatches[dispIdx]
    const sharesConvId = activeDispatch && dispatches.some(d => d.id !== activeDispatch.id && d.conversationId === activeConvId && activeConvId)
    const slicedMsgs = rawMsgs && sharesConvId ? sliceMessagesForDispatch(rawMsgs, activeDispatch, dispatches) : rawMsgs
    const isLoading = activeConvId ? convLoading.get(activeConvId) || false : false
    return { dispatches, dispIdx, slicedMsgs, isLoading }
  }, [selectedDispatch, convMessages, convLoading])

  const toggleAgent = (name: string, agent: AgentStateUpdate) => {
    // Popup mode: open floating panel instead of inline expand
    if (agentDetailPopup) {
      const hasContent = getDispatches(agent).length > 0 || meta(agent, 'fullOutput', '') || agent.status === 'running'
      if (hasContent) {
        // Default to the most recent dispatch if not already selected
        const dispatches = getDispatches(agent)
        if (dispatches.length > 0 && !selectedDispatch.has(name)) {
          setSelectedDispatch(prev => { const next = new Map(prev); next.set(name, dispatches.length - 1); return next })
        }
        setPopupAgentName(name)
        loadAgentDispatch(agent)
        return
      }
    }

    // Inline expand mode (original behavior)
    const isCurrentlyExpanded = agentExpanded.get(name) || false
    // If already expanded and a conversation is loading, ignore the click.
    // This prevents the user from accidentally collapsing the panel and
    // restarting the same slow fetch by clicking impatiently.
    if (isCurrentlyExpanded && isAgentLoading(agent)) return
    const willExpand = !isCurrentlyExpanded
    setAgentExpanded((prev) => {
      const next = new Map(prev)
      next.set(name, willExpand)
      return next
    })
    if (willExpand) {
      // Default to the most recent dispatch (last in array)
      const dispatches = getDispatches(agent)
      if (dispatches.length > 0 && !selectedDispatch.has(name)) {
        setSelectedDispatch(prev => { const next = new Map(prev); next.set(name, dispatches.length - 1); return next })
      }
      loadAgentDispatch(agent)
    }
  }

  // Drag-to-resize handler
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = panelHeight ?? DEFAULT_PANEL_HEIGHT
    const maxHeight = window.innerHeight * MAX_PANEL_PCT

    const onMouseMove = (ev: MouseEvent) => {
      // Dragging up (negative deltaY) should increase panel height
      const deltaY = startY - ev.clientY
      const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, startHeight + deltaY))
      onPanelHeightChange?.(Math.round(newHeight))
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [panelHeight, onPanelHeightChange])

  // All hooks above — safe to return early now
  if (agents.length === 0) return null

  const running = visible.filter(a => a.status === 'running').length
  const effectiveHeight = panelHeight ?? DEFAULT_PANEL_HEIGHT

  // Resolve popup data (outside the render loop, using the same logic)
  const popupData = popupAgent ? resolveDispatchData(popupAgent) : null

  return (
    <div
      ref={panelRef}
      data-ion-ui
      style={{
        borderTop: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
      {/* Drag handle for resizing */}
      {onPanelHeightChange && !panelCollapsed && !isFullscreen && (
        <div
          onMouseDown={handleDragStart}
          style={{
            height: 4,
            cursor: 'ns-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{
            width: 32,
            height: 2,
            borderRadius: 1,
            background: colors.textTertiary,
            opacity: 0.3,
            transition: 'opacity 0.15s',
          }} />
        </div>
      )}

      {/* Collapsible header */}
      <div
        data-ion-ui
        onClick={() => { userToggled.current = true; setPanelCollapsed(!panelCollapsed) }}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 20,
          padding: '0 8px',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: 10,
          color: colors.textTertiary,
          gap: 4,
        }}
      >
        <CaretRight
          size={8}
          style={{
            transform: panelCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.15s ease',
          }}
        />
        <span>Agents ({visible.length})</span>
        {onToggleFullscreen && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleFullscreen()
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: colors.textTertiary,
              display: 'flex',
              alignItems: 'center',
              marginLeft: 'auto',
            }}
            title={isFullscreen ? 'Collapse agent panel' : 'Expand agent panel'}
          >
            {isFullscreen ? <ArrowsInSimple size={10} /> : <ArrowsOutSimple size={10} />}
          </button>
        )}
        {running > 0 && (
          <span style={{ color: colors.accent, fontWeight: 600 }}>{running} active</span>
        )}
      </div>

      {/* Agent rows */}
      <AnimatePresence>
        {!panelCollapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{
              overflow: 'hidden',
              maxHeight: isFullscreen ? undefined : effectiveHeight,
              overflowY: 'auto',
            }}
          >
            {visible.map((agent) => {
              const isExpanded = agentExpanded.get(agent.name) || false
              const suffix = getStatusSuffix(agent)
              const { dispatches, dispIdx, slicedMsgs: loadedMsgs, isLoading } = resolveDispatchData(agent)

              return (
                <div key={agent.name}>
                  <div
                    data-ion-ui
                    onClick={() => toggleAgent(agent.name, agent)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      height: 22,
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    {/* Colored label */}
                    <div
                      style={{
                        minWidth: 140,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 8px',
                        background: getLabelBg(agent),
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#fff',
                        gap: 6,
                        flexShrink: 0,
                      }}
                    >
                      <span>{meta(agent, 'displayName', agent.name)}</span>
                      {suffix && (
                        <span style={{ fontWeight: 400, opacity: 0.7, fontSize: 10 }}>{suffix}</span>
                      )}
                    </div>

                    {/* Last work text */}
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        padding: '0 8px',
                        fontSize: 11,
                        color: colors.textTertiary,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {meta(agent, 'lastWork', '')}
                    </div>

                    {/* Expand caret */}
                    <div style={{ padding: '0 6px', display: 'flex', alignItems: 'center', color: colors.textTertiary }}>
                      <CaretRight
                        size={10}
                        style={{
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.15s ease',
                        }}
                      />
                    </div>
                  </div>

                  {/* Expanded output (inline mode only) */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <AgentExpandedView
                          agent={agent}
                          colors={colors}
                          loadedMessages={loadedMsgs}
                          loading={isLoading}
                          isFullscreen={isFullscreen}
                          dispatches={dispatches}
                          selectedDispatch={dispIdx}
                          onSelectDispatch={(idx) => {
                            setSelectedDispatch(prev => { const next = new Map(prev); next.set(agent.name, idx); return next })
                            const convId = dispatches[idx]?.conversationId
                            if (convId) loadSingleConversation(convId)
                          }}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating detail panel (popup mode) */}
      {popupAgent && popupData && (
        <AgentDetailPanel
          agent={popupAgent}
          loadedMessages={popupData.slicedMsgs}
          loading={popupData.isLoading}
          dispatches={popupData.dispatches}
          selectedDispatch={popupData.dispIdx}
          onSelectDispatch={(idx) => {
            setSelectedDispatch(prev => { const next = new Map(prev); next.set(popupAgent.name, idx); return next })
            const convId = popupData.dispatches[idx]?.conversationId
            if (convId) loadSingleConversation(convId)
          }}
          onClose={() => setPopupAgentName(null)}
        />
      )}
    </div>
  )
}
