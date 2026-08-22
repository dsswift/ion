/**
 * AgentDetailBody — the dispatch-preview body: breadcrumb drill-down,
 * sub-conversation loading, pinned header (pager + meta bar), and the
 * Transcript. Extracted from AgentDetailPanel so two hosts render ONE
 * implementation: the overlay's FloatingPanel popup (AgentDetailPanel) and
 * the Studio center's inline DispatchSplitPane.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { Transcript } from './conversation/Transcript'
import { DispatchPager } from './DispatchPager'
import { DispatchMetaBar } from './DispatchMetaBar'
import { meta, childrenOfDispatch, childAgentsOf, getDispatches, findDispatchById, telemetryToDispatchInfo } from './agent-panel-helpers'
import { mapConversationMessages } from './agent-conversation-mapper'
import type { DispatchInfo, BreadcrumbFrame } from './agent-panel-helpers'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'
import type { DispatchTelemetryEntry } from '../../shared/types-engine'
import { rError } from '../rendererLogger'

export interface AgentDetailBodyProps {
  agent: AgentStateUpdate
  loadedMessages: Message[] | undefined
  loading: boolean
  dispatches: DispatchInfo[]
  selectedDispatch: number
  onSelectDispatch: (idx: number) => void
  /** Flat dispatch telemetry for deriving child dispatches (live stream). */
  dispatchTelemetry?: DispatchTelemetryEntry[]
  /** Full agent-state list — durable source for nested children. */
  allAgents?: AgentStateUpdate[]
  /** Pre-populated breadcrumb stack for deep-link entry. */
  initialStack?: BreadcrumbFrame[]
  /** Studio supplies agent title in its pane chrome, so hide root duplicate. */
  hideRootBreadcrumb?: boolean
}

export function AgentDetailBody({
  agent,
  loadedMessages,
  loading,
  dispatches,
  selectedDispatch,
  onSelectDispatch,
  dispatchTelemetry,
  allAgents,
  initialStack,
  hideRootBreadcrumb = false,
}: AgentDetailBodyProps): React.JSX.Element {
  const colors = useColors()
  const unifiedTurnView = usePreferencesStore((s) => s.unifiedTurnView)

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
        dispatches: [telemetryToDispatchInfo(entry)],
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
  //
  // Non-root resolution mirrors the child-listing logic above: DURABLE
  // agent-state pill first (survives heartbeat replay, carries the dispatch's
  // own model/startTime), one-shot dispatchTelemetry as the live supplement.
  // When neither knows the dispatch, the header renders no meta row. It must
  // NEVER fall back to the root frame's dispatch: that displays the PARENT
  // agent's model and ticking duration under the child's breadcrumb (e.g. a
  // dev-lead's Opus id and elapsed shown for its Sonnet specialist).
  const topTelemetryEntry = isRoot
    ? undefined
    : dispatchTelemetry?.find(e => e.dispatchId === top.dispatchId)
  const topDispatch: DispatchInfo | undefined = isRoot
    ? dispatches[selectedDispatch]
    : findDispatchById(allAgents ?? [], top.dispatchId)
      ?? (topTelemetryEntry ? telemetryToDispatchInfo(topTelemetryEntry) : undefined)

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Pinned header host: breadcrumb + dispatch tab strip + metadata row */}
      <div ref={headerHostCallback} style={{ flexShrink: 0 }} />
      {headerHost && createPortal(
        <>
          {!hideRootBreadcrumb || stack.length > 1 ? breadcrumb : null}
          <DispatchPager
            agent={agent}
            allAgents={allAgents ?? [agent]}
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
            allAgents={allAgents}
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
  )
}
