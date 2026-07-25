import React from 'react'
import { useColors } from '../theme'
import { DurationDisplay } from './AgentExpandedView'
import type { DispatchInfo } from './agent-panel-helpers'

interface Props {
  dispatch: DispatchInfo | undefined
  agentStatus: string
}

/**
 * Single-row metadata bar showing model name and duration for the currently
 * selected dispatch. Rendered in the AgentDetailPanel pinned header zone,
 * directly below the DispatchPager (or directly below the breadcrumb for
 * single-dispatch agents).
 *
 * Mirrors AgentExpandedView's infoBar block but without the inline left-pad
 * logic (the popup header always uses compact/flush alignment).
 */
export function DispatchMetaBar({ dispatch, agentStatus }: Props) {
  const colors = useColors()

  if (!dispatch) return null

  const model = dispatch.model || ''
  const startTime = dispatch.startTime
  const elapsed = dispatch.elapsed
  const status = dispatch.status || agentStatus

  if (!model && startTime == null && elapsed == null) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 12px',
        background: colors.surfaceHover,
        fontSize: 10,
        color: colors.textTertiary,
        borderBottom: `1px solid ${colors.borderSubtle}`,
      }}
    >
      {model && <span>Model: {model}</span>}
      {model && (startTime != null || elapsed != null) && (
        <span style={{ opacity: 0.4 }}>|</span>
      )}
      {(startTime != null || elapsed != null) && (
        <span>
          Duration: <DurationDisplay startTime={startTime} elapsed={elapsed} status={status} />
        </span>
      )}
    </div>
  )
}
