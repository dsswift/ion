/**
 * GraphWatchChip — the persistent, non-blocking notice that live updates are
 * off for some or all of the corpus. Absent while every root is watched.
 *
 * Two degraded states, one chip: the watcher module is missing entirely
 * (`unavailable`, the whole graph is a point-in-time read) or at least one
 * root's subscription failed (`partial`, the graph is live for the other
 * roots). The design rule this enforces: there is no code path where a
 * stale graph looks indistinguishable from a live one.
 */

import React from 'react'
import { useColors } from '../../theme'
import { Tooltip } from '../../components/git/Tooltip'
import { useGraphStore } from './graph-store'
import type { CorpusRootStatus } from '../../../shared/graph-corpus-types'

export function watchChipText(watchState: 'unavailable' | 'partial', roots: CorpusRootStatus[]): { label: string; detail: string | null } {
  if (watchState === 'unavailable') {
    return { label: 'Live updates off — point-in-time read', detail: null }
  }
  const failed = roots.filter((r) => r.watch === 'failed')
  const label = `Live updates off for ${failed.length} of ${roots.length} roots`
  return { label, detail: failed.map((r) => r.label ?? r.path).join(', ') }
}

export function GraphWatchChip(): React.JSX.Element | null {
  const colors = useColors()
  const watchState = useGraphStore((s) => s.watchState)
  const roots = useGraphStore((s) => s.snapshot?.roots ?? [])
  if (watchState !== 'unavailable' && watchState !== 'partial') return null

  const { label, detail } = watchChipText(watchState, roots)
  const chip = (
    <div
      style={{
        padding: '3px 8px',
        borderRadius: 6,
        background: colors.surfaceSecondary,
        border: `1px solid ${colors.containerBorder}`,
        color: colors.textTertiary,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {label}
    </div>
  )

  return (
    // The last item of the toolbar row, pushed to its right edge; the row
    // owns the geometry so the chip never lands on another control.
    <div style={{ marginLeft: 'auto', pointerEvents: 'auto' }}>
      {detail ? <Tooltip text={detail} position="below">{chip}</Tooltip> : chip}
    </div>
  )
}
