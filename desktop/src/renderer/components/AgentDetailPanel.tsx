import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { FloatingPanel } from './FloatingPanel'
import { Transcript } from './conversation/Transcript'
import { DispatchPager } from './DispatchPager'
import { DispatchMetaBar } from './DispatchMetaBar'
import { meta, childrenOfDispatch, childAgentsOf, getDispatches } from './agent-panel-helpers'
import { mapConversationMessages } from './agent-conversation-mapper'
import type { DispatchInfo, BreadcrumbFrame } from './agent-panel-helpers'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'
import type { DispatchTelemetryEntry } from '../../shared/types-engine'
import { rError } from '../rendererLogger'

// BreadcrumbFrame now lives with the pure helpers in renderer/lib/agent-helpers
// (buildBreadcrumbStack constructs it). Re-exported here so existing imports
// of the type from this component keep working.
export type { BreadcrumbFrame }

interface AgentDetailPanelProps {
  agent: AgentStateUpdate
  loadedMessages: Message[] | undefined
  loading: boolean
  dispatches: DispatchInfo[]
  selectedDispatch: number
  onSelectDispatch: (idx: number) => void
  onClose: () => void
  /** Flat dispatch telemetry for deriving child dispatches (live stream). */
  dispatchTelemetry?: DispatchTelemetryEntry[]
  /**
   * The full agent-state list for the active instance. The DURABLE source for
   * nested children: agent-state pills carry dispatchParentId/dispatches[] and
   * survive `engine_agent_state` heartbeat replay, so the preview renders
   * children correctly even when the one-shot dispatchTelemetry was missed
   * (late attach / tab reopen). See childAgentsOf in agent-panel-helpers.
   */
  allAgents?: AgentStateUpdate[]
  /**
   * Pre-populated breadcrumb stack for deep-link entry. When provided, the
   * panel initializes with this stack instead of the root-only single-frame
   * default. Built by `buildBreadcrumbStack` in agent-panel-helpers, which
   * walks dispatchParentId up through durable agentStates.
   *
   * Enables n-tier deep-links from the StatusDrawer without requiring the
   * user to drill down through each intermediate tier manually.
   */
  initialStack?: BreadcrumbFrame[]
}

export function AgentDetailPanel({
  agent,
  loadedMessages,
  loading,
  dispatches,
  selectedDispatch,
  onSelectDispatch,
  onClose,
  dispatchTelemetry,
  allAgents,
  initialStack,
}: AgentDetailPanelProps) {
  const colors = useColors()
  const unifiedTurnView = usePreferencesStore((s) => s.unifiedTurnView)
  const geometry = useSessionStore((s) => s.agentDetailGeometry)
  const setGeometry = useSessionStore((s) => s.setAgentDetailGeometry)
  const handleGeometryChange = useCallback(
    (geo: { x: number; y: number; w: number; h: number }) => setGeometry(geo),
    [setGeometry],
  )

  // Breadcrumb stack. When initialStack is provided (deep-link from StatusDrawer),
  // use it as the starting point. Otherwise start at the root frame (single entry).
  const rootDispatch = dispatches[selectedDispatch]
  const rootFrame: BreadcrumbFrame = {
    dispatchId: rootDispatch?.id ?? '',
    conversationId: rootDispatch?.conversationId ?? '',
    agentDisplayName: meta(agent, 'displayName', agent.name),
  }
  const [stack, setStack] = useState<BreadcrumbFrame[]>(() =>
    initialStack && initialStack.length > 0 ? initialStack : [rootFrame],
  )

  // Stable identity of the deep-link target. `initialStack` is a fresh array on
  // every render (StatusDrawer memoizes deepLinkData on agentStates, so a
  // heartbeat rebuilds it), but its TARGET dispatch only changes when the user
  // deep-links to a genuinely different dispatch. Keying the reset on this
  // string instead of the array ref stops a rebuilt-but-identical initialStack
  // from clobbering a manual drill-down.
  const initialStackTargetId = initialStack && initialStack.length > 0
    ? initialStack[initialStack.length - 1]?.dispatchId ?? ''
    : ''

  // Reset stack ONLY when the root subject identity genuinely changes. The deps
  // are deliberately restricted to stable primitives: `agent` and `initialStack`
  // are new object/array references on every engine_agent_state heartbeat (the
  // popup passes popupAgent = visible.find(...), rebuilt each heartbeat), so
  // depending on them would refire this reset mid-drill and snap the breadcrumb
  // back to the root — the exact bug this guards against. `agent.name`,
  // `rootDispatch?.id`, `rootDispatch?.conversationId`, and `initialStackTargetId`
  // are stable across heartbeats and change on every genuine subject change
  // (different agent, pager switch, or a different deep-link target).
  useEffect(() => {
    if (initialStack && initialStack.length > 0) {
      setStack(initialStack)
    } else {
      setStack([{
        dispatchId: rootDispatch?.id ?? '',
        conversationId: rootDispatch?.conversationId ?? '',
        agentDisplayName: meta(agent, 'displayName', agent.name),
      }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootDispatch?.id, rootDispatch?.conversationId, agent.name, initialStackTargetId])

  const top = stack[stack.length - 1]

  // Load sub-conversation messages for the top-of-stack frame.
  const [subMessages, setSubMessages] = useState<Map<string, Message[]>>(new Map())
  const [subLoading, setSubLoading] = useState<Map<string, boolean>>(new Map())

  const loadConversation = useCallback(async (convId: string) => {
    if (!convId || subMessages.has(convId)) return
    setSubLoading(prev => { const next = new Map(prev); next.set(convId, true); return next })
    try {
      const data = await window.ion.getConversation(convId, 0, 200)
      const msgs: Message[] = mapConversationMessages(data.messages || [])
      setSubMessages(prev => { const next = new Map(prev); next.set(convId, msgs); return next })
    } catch (err) {
      rError('agent-detail-panel', 'loadConversation error', { error: String(err) })
    } finally {
      setSubLoading(prev => { const next = new Map(prev); next.set(convId, false); return next })
    }
  }, [subMessages])

  // Load conversation whenever the top frame changes.
  useEffect(() => {
    if (top.conversationId) void loadConversation(top.conversationId)
  }, [top.conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve messages for the current top frame.
  const isRoot = stack.length === 1
  const topMessages = isRoot
    ? loadedMessages
    : subMessages.get(top.conversationId)
  const topLoading = isRoot
    ? loading
    : (subLoading.get(top.conversationId) ?? false)

  // Derive pinned prompt from the first user message in the sub-conversation.
  const pinnedPrompt = topMessages?.find(m => m.role === 'user')?.content

  // Child dispatches for the current frame (for embedding in the Transcript's AgentPanel).
  const childTelemetry = (dispatchTelemetry && top.dispatchId)
    ? childrenOfDispatch(dispatchTelemetry, top.dispatchId)
    : []

  // Build the child agent set for the embedded panel.
  //
  // DURABLE source first: agent-state pills whose dispatchParentId equals the
  // current frame's dispatch id. These are complete (they carry their own
  // dispatches[] with conversationId, displayName, status, elapsed) and survive
  // engine_agent_state heartbeat replay, so a child renders even when the
  // one-shot dispatchTelemetry was never observed (late attach / tab reopen).
  // This is the fix for the empty-preview bug.
  const childAgentPills = childAgentsOf(allAgents ?? [], top.dispatchId)

  // LIVE supplement: a child can emit dispatch_start before its first
  // agent-state snapshot lands. Union the telemetry-derived stubs in, keyed by
  // dispatch id, with the durable agent-state pill winning when both exist.
  const pillDispatchIds = new Set(
    childAgentPills.flatMap(a => getDispatches(a).map(d => d.id).filter(Boolean)),
  )
  const telemetryOnlyStubs: AgentStateUpdate[] = childTelemetry
    .filter(entry => !pillDispatchIds.has(entry.dispatchId))
    .map(entry => ({
      name: entry.dispatchAgent,
      status: entry.exitCode !== undefined ? (entry.exitCode === 0 ? 'done' : 'error') : 'running',
      metadata: {
        displayName: entry.dispatchAgent,
        dispatchParentId: entry.dispatchParentId,
        dispatchDepth: entry.dispatchDepth,
        dispatches: [{
          id: entry.dispatchId,
          task: entry.dispatchTask,
          model: entry.dispatchModel,
          conversationId: entry.conversationId ?? '',
          elapsed: entry.elapsed,
          status: entry.exitCode !== undefined ? (entry.exitCode === 0 ? 'done' : 'error') : 'running',
        }],
      },
    }))

  const childAgentStates: AgentStateUpdate[] = [...childAgentPills, ...telemetryOnlyStubs]

  // Handle opening a child dispatch.
  const handleOpenDispatch = useCallback((dispatch: DispatchInfo, childAgent: AgentStateUpdate) => {
    if (!dispatch.conversationId) return
    setStack(prev => [...prev, {
      dispatchId: dispatch.id,
      conversationId: dispatch.conversationId,
      agentDisplayName: meta(childAgent, 'displayName', childAgent.name),
    }])
  }, [])

  // Pop the stack to a specific index.
  const popTo = useCallback((idx: number) => {
    setStack(prev => prev.slice(0, idx + 1))
  }, [])

  // Header portal host.
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null)
  const headerHostCallback = useCallback((node: HTMLDivElement | null) => {
    setHeaderHost(node)
  }, [])

  // Resolve the dispatch info for the top-of-stack frame so the header
  // chrome reflects the currently-viewed dispatch (root or drilled-in child).
  const topDispatch: DispatchInfo | undefined = isRoot
    ? dispatches[selectedDispatch]
    : (() => {
        // Find the dispatch from dispatchTelemetry that matches the current frame.
        const entry = dispatchTelemetry?.find(e => e.dispatchId === top.dispatchId)
        if (!entry) return dispatches[selectedDispatch]
        return {
          id: entry.dispatchId,
          task: entry.dispatchTask,
          model: entry.dispatchModel,
          conversationId: entry.conversationId ?? '',
          elapsed: entry.elapsed,
          status: entry.exitCode !== undefined
            ? (entry.exitCode === 0 ? 'done' : 'error')
            : 'running',
          startTime: undefined,
        }
      })()

  // For the DispatchPager: at root level show all root dispatches with the
  // selectedDispatch index. When drilled into a child, the child has no
  // sibling pager — show empty so DispatchPager's own guard hides it.
  const headerDispatches = isRoot ? dispatches : []
  const headerSelectedIndex = isRoot ? selectedDispatch : 0
  const headerOnSelect = isRoot ? onSelectDispatch : () => {}

  // Breadcrumb bar rendered into the header portal.
  const breadcrumb = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 12px',
        fontSize: 11,
        color: colors.textTertiary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        flexWrap: 'wrap',
      }}
    >
      {stack.map((frame, idx) => {
        const isLast = idx === stack.length - 1
        return (
          <React.Fragment key={`${frame.dispatchId}-${idx}`}>
            {idx > 0 && <CaretRight size={8} style={{ opacity: 0.5 }} />}
            <span
              onClick={isLast ? undefined : () => popTo(idx)}
              style={{
                cursor: isLast ? 'default' : 'pointer',
                fontWeight: isLast ? 600 : 400,
                color: isLast ? colors.textPrimary : colors.accent,
              }}
            >
              {frame.agentDisplayName}
            </span>
          </React.Fragment>
        )
      })}
    </div>
  )

  const title = meta(agent, 'displayName', agent.name)

  return (
    <FloatingPanel
      title={title}
      onClose={onClose}
      defaultWidth={600}
      defaultHeight={500}
      initialPos={{ x: geometry.x, y: geometry.y }}
      initialSize={{ w: geometry.w, h: geometry.h }}
      onGeometryChange={handleGeometryChange}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Pinned header host: breadcrumb + dispatch tab strip + metadata row */}
        <div ref={headerHostCallback} style={{ flexShrink: 0 }} />
        {headerHost && createPortal(
          <>
            {breadcrumb}
            <DispatchPager
              dispatches={headerDispatches}
              selectedIndex={headerSelectedIndex}
              onSelect={headerOnSelect}
              compact
            />
            <DispatchMetaBar dispatch={topDispatch} agentStatus={agent.status} />
          </>,
          headerHost,
        )}

        {/* Scrolling transcript body */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {topLoading && (
            <div style={{ padding: '12px', fontSize: 11, color: colors.textTertiary }}>
              Loading conversation...
            </div>
          )}
          {!topLoading && topMessages && (
            <Transcript
              messages={topMessages}
              unifiedTurnView={unifiedTurnView}
              pinnedPrompt={pinnedPrompt}
              isRunning={agent.status === 'running'}
              agents={childAgentStates}
              dispatchTelemetry={childTelemetry}
              onOpenDispatch={handleOpenDispatch}
              subDispatch
            />
          )}
          {!topLoading && !topMessages && (
            <div style={{ padding: '12px', fontSize: 11, color: colors.textTertiary }}>
              No conversation data available
            </div>
          )}
        </div>
      </div>
    </FloatingPanel>
  )
}
