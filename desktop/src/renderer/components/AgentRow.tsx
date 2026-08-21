import React from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { meta, getAgentColor, getDispatches, mostRecentDispatch } from './agent-panel-helpers'
import { resolveAgentDotModel } from '../lib/agent-dot-model'
import { StatusDot, StatusDotStack } from './TabStripStatusDot'
import { DurationDisplay } from './DurationDisplay'
import type { useColors } from '../theme'
import type { AgentStateUpdate } from '../../shared/types'

interface Props {
  agent: AgentStateUpdate
  /** Full tree retains legacy descendant fallback for older dispatch metadata. */
  allAgents: AgentStateUpdate[]
  colors: ReturnType<typeof useColors>
  /** Left indent (px) for a nested dispatch, 0 for root-level rows. */
  nestIndent: number
  onToggle: () => void
}

/**
 * A single agent-panel row: name pill + standardized status dot + duration +
 * activity text + caret. Extracted from AgentPanel so that file stays under
 * the 600-line cap.
 *
 * The row is a STATUS SUMMARY, not a navigable surface: clicking it opens the
 * floating detail panel (the only way to inspect a dispatch), and the row body
 * never expands inline. Everything it renders therefore describes the agent's
 * state right now, independent of whatever dispatch the detail panel happens
 * to have selected.
 *
 * The row visual mirrors iOS AgentBarRow (a rounded name pill, a separate
 * status dot, monospace duration) and the status dot reuses the platform's
 * standardized vocabulary (TabStripStatusDot): pulsing orange for running,
 * pulsing yellow for "waiting on dispatched children", solid green for done.
 * The dot carries all status meaning — the row shows no text status suffix.
 */
export function AgentRow({
  agent,
  allAgents,
  colors,
  nestIndent,
  onToggle,
}: Props) {
  // The row's status indicator. `resolveAgentDotModel` takes no selected-
  // dispatch index on purpose: the foreground dot always describes the most
  // recent dispatch and the background dot always aggregates the earlier ones,
  // so paging around inside the detail panel can never repoint what this row
  // reports. See agent-dot-model.ts for why the two are kept separate.
  const dotModel = resolveAgentDotModel(agent, allAgents, colors)
  // Duration follows the same subject as the foreground dot — the most recent
  // dispatch — so the clock and the dot beside it never describe different
  // dispatches. Falls back to the agent's own metadata for a roster row that
  // carries no dispatch at all.
  const dispatches = getDispatches(agent)
  const dispatchCount = dispatches.length
  const recent = mostRecentDispatch(dispatches)
  const durStartTime = recent?.startTime ?? (agent.metadata?.startTime as number | undefined)
  const durElapsed = recent?.elapsed ?? (agent.metadata?.elapsed as number | undefined)
  const durStatus = recent?.status || agent.status

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
              color: colors.textOnAccent,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {meta(agent, 'displayName', agent.name)}
          </span>
          {dispatchCount > 0 && (
            <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0 }}>
              {dispatchCount} {dispatchCount === 1 ? 'dispatch' : 'dispatches'}
            </span>
          )}
          {/* Standardized status dot(s) — same vocabulary as the tab and
              status-bar dots (TabStripStatusDot). One dot when the agent has a
              single dispatch; two overlapping dots when it has more, so a
              finished most-recent dispatch cannot hide an older one that is
              still waiting on a live agent. The ring uses the panel surface so
              the two layers separate visually. */}
          {dotModel.kind === 'stack' ? (
            <StatusDotStack
              foreground={dotModel.foreground}
              background={dotModel.background}
              ringColor={colors.surfacePrimary}
              size={8}
            />
          ) : (
            <StatusDot
              derived={{
                bg: dotModel.dot.bg,
                pulse: dotModel.dot.pulse,
                glow: Boolean(dotModel.dot.glowColor),
                glowColor: dotModel.dot.glowColor,
              }}
              size={8}
            />
          )}
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

        {/* Open-detail caret. Static: the row never expands in place, so the
            caret is an affordance for "this opens", not an expanded/collapsed
            state indicator. */}
        <div style={{ padding: '0 6px', display: 'flex', alignItems: 'center', color: colors.textTertiary }}>
          <CaretRight size={10} />
        </div>
      </div>
    </div>
  )
}
