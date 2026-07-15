import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight } from '@phosphor-icons/react'
import { meta, getAgentColor, getStatusDot, childAgentsOf } from './agent-panel-helpers'
import { AgentExpandedView, DurationDisplay } from './AgentExpandedView'
import type { useColors } from '../theme'
import type { AgentStateUpdate, Message } from '../../shared/types'
import type { DispatchInfo } from '../../shared/types-engine'

interface Props {
  agent: AgentStateUpdate
  /** The full, unfiltered agents array — used to derive the yellow
   *  "waiting on children" state via childAgentsOf. */
  allAgents: AgentStateUpdate[]
  colors: ReturnType<typeof useColors>
  isFullscreen?: boolean
  isExpanded: boolean
  /** Resolved dispatch data for this agent (from AgentPanel.resolveDispatchData). */
  dispatches: DispatchInfo[]
  dispIdx: number
  loadedMessages?: Message[]
  loading: boolean
  /** Left indent (px) for a nested dispatch, 0 for root-level rows. */
  nestIndent: number
  onToggle: () => void
  onSelectDispatch: (idx: number) => void
}

/**
 * A single agent-panel row: name pill + standardized status dot + duration +
 * activity text + caret, with the inline expanded view beneath it. Extracted
 * from AgentPanel so that file stays under the 600-line cap.
 *
 * The row visual mirrors iOS AgentBarRow (a rounded name pill, a separate
 * status dot, monospace duration) and the status dot reuses the platform's
 * standardized vocabulary (TabStripStatusDot): pulsing orange for running,
 * pulsing yellow for "running but waiting on dispatched children", solid green
 * for done. The dot carries all status meaning — the row shows no text status
 * suffix.
 */
export function AgentRow({
  agent,
  allAgents,
  colors,
  isFullscreen,
  isExpanded,
  dispatches,
  dispIdx,
  loadedMessages,
  loading,
  nestIndent,
  onToggle,
  onSelectDispatch,
}: Props) {
  // Yellow "waiting on children" derivation: a running agent whose own activity
  // is idle because a dispatched child is still running. Match children by the
  // agent's selected dispatch id.
  const selDispatch = dispatches[dispIdx]
  const selDispatchId = selDispatch?.id ?? ''
  const hasRunningChildren =
    agent.status === 'running' &&
    childAgentsOf(allAgents, selDispatchId).some((c) => c.status === 'running')
  const dot = getStatusDot(agent, colors, hasRunningChildren)
  // Duration source mirrors the expanded view: the selected dispatch's clock
  // when present, else the agent's own metadata. DurationDisplay live-ticks
  // while running and formats on finish.
  const durStartTime = selDispatch?.startTime ?? (agent.metadata?.startTime as number | undefined)
  const durElapsed = selDispatch?.elapsed ?? (agent.metadata?.elapsed as number | undefined)
  const durStatus = selDispatch?.status || agent.status

  return (
    <div>
      <div
        data-ion-ui
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 22,
          cursor: 'pointer',
          userSelect: 'none',
          paddingLeft: nestIndent || undefined,
        }}
      >
        {/* Name pill + status dot + duration (iOS AgentBarRow parity) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 8px',
            flexShrink: 0,
          }}
        >
          {/* Capsule name pill */}
          <span
            style={{
              borderRadius: 999,
              background: getAgentColor(agent),
              opacity: 0.85,
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {meta(agent, 'displayName', agent.name)}
          </span>
          {/* Standardized status dot — same vocabulary as the tab and
              status-bar dots (TabStripStatusDot). */}
          <span
            className={`rounded-full flex-shrink-0${dot.pulse ? ' animate-pulse-dot' : ''}`}
            style={{
              width: 8,
              height: 8,
              background: dot.bg,
              ...(dot.glowColor ? { boxShadow: `0 0 6px 2px ${dot.glowColor}` } : {}),
            }}
          />
          {/* Duration (live-ticking while running) */}
          <span style={{ fontSize: 10, color: colors.textTertiary, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            <DurationDisplay startTime={durStartTime} elapsed={durElapsed} status={durStatus} />
          </span>
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
              loadedMessages={loadedMessages}
              loading={loading}
              isFullscreen={isFullscreen}
              dispatches={dispatches}
              selectedDispatch={dispIdx}
              onSelectDispatch={onSelectDispatch}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
