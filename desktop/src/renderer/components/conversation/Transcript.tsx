import React, { useMemo } from 'react'

import { useColors } from '../../theme'
import { groupMessages } from './tool-helpers'
import { TranscriptRows } from './TranscriptRows'
import { useScrollFollow } from './useScrollFollow'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { AgentPanel } from '../AgentPanel'
import type { Message } from '../../../shared/types-session'
import type { AgentStateUpdate } from '../../../shared/types-engine'
import type { DispatchTelemetryEntry } from '../../../shared/types-engine'

// Stable empty refs to avoid new references each render (same pattern
// as ConversationView.tsx).
const EMPTY_AGENTS: AgentStateUpdate[] = []
const EMPTY_TELEMETRY: DispatchTelemetryEntry[] = []

export interface TranscriptProps {
  messages: Message[]
  unifiedTurnView: boolean
  pinnedPrompt?: string
  isRunning: boolean
  /** Per-message action renderer (rewind/fork menu on user bubbles). */
  actions?: (msg: Message) => React.ReactNode
  /** Live agent state updates for the embedded AgentPanel. */
  agents?: AgentStateUpdate[]
  /** Flat dispatch telemetry for agent nesting depth. */
  dispatchTelemetry?: DispatchTelemetryEntry[]
  /** Called when the user opens a dispatch detail popup from the agent panel. */
  onOpenDispatch?: (dispatch: import('../../../shared/types-engine').DispatchInfo, agent: AgentStateUpdate) => void
  /**
   * True when this transcript renders a sub-dispatch tier (inside the
   * dispatch-preview popup). Forwarded to the embedded AgentPanel so it bypasses
   * the top-level-only visibility filter and always shows the dispatched agents.
   */
  subDispatch?: boolean
}

/**
 * Unified, shared transcript renderer. Groups messages and renders every
 * kind (user, assistant, tool-group, agent-turn, thinking, harness,
 * intercept, system, compaction). Includes scroll-follow behavior, the
 * scroll-to-bottom FAB, an optional pinned-prompt bar, and the embedded
 * AgentPanel.
 */
export function Transcript({
  messages,
  unifiedTurnView,
  pinnedPrompt,
  isRunning,
  actions,
  agents,
  dispatchTelemetry,
  onOpenDispatch,
  subDispatch,
}: TranscriptProps) {
  const colors = useColors()
  const grouped = useMemo(
    () => groupMessages(messages, { includeUser: true, unifiedTurnView }),
    [messages, unifiedTurnView],
  )

  const agentList = agents ?? EMPTY_AGENTS
  const telemetry = dispatchTelemetry ?? EMPTY_TELEMETRY

  const { scrollRef, showScrollBtn, handleScroll, scrollToBottom } = useScrollFollow([
    messages.length,
    agentList.length,
    isRunning,
  ])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Pinned prompt bar */}
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

      {/* Scrollable body */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{ height: '100%', overflowY: 'auto', padding: '8px 12px' }}
        >
          <TranscriptRows grouped={grouped} actions={actions} />
        </div>
        <ScrollToBottomButton visible={showScrollBtn} onClick={scrollToBottom} />
      </div>

      {/* Embedded agent panel. Always rendered inside the dispatch preview so
          the panel is present even before the lead dispatches a specialist
          (shows "Agents (0)"), then populates as children spawn. */}
      <AgentPanel
        agents={agentList}
        dispatchTelemetry={telemetry}
        onOpenDispatch={onOpenDispatch}
        subDispatch={subDispatch}
        alwaysRender
      />
    </div>
  )
}
