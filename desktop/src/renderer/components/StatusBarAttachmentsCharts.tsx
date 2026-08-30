/**
 * The Charts section of the attachments popover.
 *
 * Charts get their own section rather than joining the generic Resources list,
 * because their row does something different: it navigates the transcript to
 * the chart's current card instead of opening a viewer. One row per named
 * chart, never one per revision — the whole point of a named chart is that it
 * stays a single entry however often it is refreshed, so a chart updated ten
 * times still occupies one line here and the `v10` badge carries the depth.
 */

import React from 'react'
import { CaretRight, ChartLine } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { transitions } from '../theme-tokens'
import { rInfo } from '../rendererLogger'
import { AttachmentRow } from './StatusBarAttachmentsRow'
import type { ChartAttachmentEntry } from './chart-attachment'

interface ChartsSectionProps {
  charts: ChartAttachmentEntry[]
  colors: ReturnType<typeof useColors>
  /** True when a section renders above this one, which needs a divider. */
  showDivider: boolean
  collapsed: boolean
  onToggle: () => void
  /** Closes the popover; a jump is pointless behind an open overlay. */
  onDismiss: () => void
  activeTabId: string | null
}

export function ChartsSection({
  charts, colors, showDivider, collapsed, onToggle, onDismiss, activeTabId,
}: ChartsSectionProps) {
  if (charts.length === 0) return null

  return (
    <div>
      {showDivider && (
        <div style={{ height: 1, background: colors.popoverBorder, margin: '4px 10px' }} />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 w-full ion-focusable"
        style={{
          fontSize: 9,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: colors.accent,
          padding: '4px 12px 2px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <CaretRight
          size={8}
          weight="bold"
          style={{
            flexShrink: 0,
            transition: `transform ${transitions.fast}`,
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
          }}
        />
        <span>Charts ({charts.length})</span>
      </button>
      {!collapsed && charts.map((chart) => (
        <AttachmentRow
          key={chart.chartId}
          colors={colors}
          hoverBg={colors.accentLight}
          color={colors.textSecondary}
          onClick={() => {
            onDismiss()
            if (!activeTabId) return
            rInfo('attachments', 'chart row activated', {
              chart_id: chart.chartId, revision: chart.revision,
            })
            window.ion.requestChartJump({
              tabId: activeTabId,
              chartId: chart.chartId,
              messageId: chart.toolMessageId,
            })
          }}
        >
          <ChartLine size={13} style={{ flexShrink: 0, color: colors.accent }} />
          <span className="truncate flex-1">{chart.title}</span>
          {chart.revision > 1 && (
            <span
              className="tabular-nums"
              style={{ fontSize: 9, flexShrink: 0, color: colors.textTertiary }}
            >
              {`v${chart.revision}`}
            </span>
          )}
        </AttachmentRow>
      ))}
    </div>
  )
}
