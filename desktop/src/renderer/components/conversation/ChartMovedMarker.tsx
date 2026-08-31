import React, { useCallback } from 'react'
import { ChartLine, ArrowDown } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { rDebug } from '../../rendererLogger'

/**
 * ChartMovedMarker — what an earlier chart revision's location shows once the
 * chart has been revised.
 *
 * ── Why a marker and not silence ────────────────────────────────────────────
 * The turn that produced revision 1 still happened, and the transcript is a
 * record. Deleting the row would rewrite history; leaving a full chart there
 * would show the operator stale numbers with equal visual weight to the
 * current ones. A marker keeps the turn honest ("a chart was rendered here")
 * while making it unmistakable that the live version is elsewhere — and gives
 * a one-click path to it.
 */
export const ChartMovedMarker = React.memo(function ChartMovedMarker({
  chartId,
  title,
  targetMessageId,
  tabId,
}: {
  chartId: string
  title: string
  targetMessageId: string
  tabId?: string
}) {
  const colors = useColors()

  const jump = useCallback(() => {
    if (!tabId) return
    rDebug('conversation.chart', 'moved marker jump', {
      chart_id: chartId, target: targetMessageId.slice(0, 12),
    })
    window.ion.requestChartJump({ tabId, chartId, messageId: targetMessageId })
  }, [tabId, chartId, targetMessageId])

  return (
    <button
      data-testid="chart-moved-marker"
      data-chart-id={chartId}
      data-chart-target={targetMessageId}
      onClick={jump}
      disabled={!tabId}
      className="flex items-center gap-1.5 ion-focusable"
      style={{
        marginTop: 4,
        marginBottom: 4,
        padding: '3px 8px',
        borderRadius: 4,
        border: `1px dashed ${colors.borderSubtle}`,
        background: 'transparent',
        cursor: tabId ? 'pointer' : 'default',
        fontSize: 10,
        color: colors.textTertiary,
        maxWidth: 720,
      }}
    >
      <ChartLine size={11} style={{ flexShrink: 0 }} />
      <span className="truncate">
        <span style={{ color: colors.textSecondary }}>{title}</span>
        {' was updated — the current version is below'}
      </span>
      <ArrowDown size={10} style={{ flexShrink: 0 }} />
    </button>
  )
})
