import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Chart as ChartJS, registerables } from 'chart.js'
import annotationPlugin from 'chartjs-plugin-annotation'
import datalabelsPlugin from 'chartjs-plugin-datalabels'
import { Chart } from 'react-chartjs-2'
import { CaretLeft, CaretRight, Copy, Table } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { rError, rInfo, rWarn } from '../../rendererLogger'
import { Tooltip } from '../git/Tooltip'
import { buildChartConfig, chartValueRows } from './chart-config'
import { hasSeveralRevisions, revisionStatus, type ChartTimeline } from './chart-revisions'

/**
 * ChartOutputCard — one Chart Output in the transcript.
 *
 * ── Registration happens once, at module load ───────────────────────────────
 * Chart.js is tree-shakeable: nothing renders unless its controllers, scales,
 * and elements are registered. Doing it here (module scope, guarded) rather
 * than per-render means the first chart in a session pays no setup cost and a
 * second card cannot double-register.
 *
 * ── Why the value table is not optional chrome ──────────────────────────────
 * A chart answers "roughly how much" by design. The operator copying a chart
 * into an answer for someone else needs "exactly how much" too, and a
 * screen-reader user needs it as the only representation. So every card can
 * expand the exact numbers, rendered from the same resolved series the canvas
 * draws — the two cannot disagree.
 *
 * ── Revision chrome appears only when it means something ────────────────────
 * A chart with one revision shows no pager and no status pill: there is
 * nothing to navigate and nothing to warn about. The moment a chart has been
 * revised, the card gains previous/next and labels the page Current or
 * Outdated, because an operator paging back must never mistake old data for
 * the live answer.
 */

let registered = false
function ensureChartJsRegistered(): void {
  if (registered) return
  ChartJS.register(...registerables, annotationPlugin, datalabelsPlugin)
  // Data labels are opt-in per chart (spec.showValues); registering the plugin
  // globally without disabling it by default would print values on every
  // chart, which is unreadable on a dense series.
  ChartJS.defaults.set('plugins.datalabels', { display: false })
  registered = true
}

/** Height of the plot area, px. Bounded so a chart never dominates the scroll. */
const CHART_HEIGHT = 260

interface ChartOutputCardProps {
  timeline: ChartTimeline
}

export const ChartOutputCard = React.memo(function ChartOutputCard({
  timeline,
}: ChartOutputCardProps) {
  ensureChartJsRegistered()
  const colors = useColors()
  const chartRef = useRef<ChartJS | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  // Paging index into the revision list. Defaults to the newest, so a card
  // always opens on the current answer.
  const [pageIndex, setPageIndex] = useState<number | null>(null)

  const latestIndex = timeline.revisions.length - 1
  const activeIndex = pageIndex ?? latestIndex
  const clampedIndex = Math.min(Math.max(activeIndex, 0), latestIndex)
  const revision = timeline.revisions[clampedIndex]
  const spec = revision?.spec
  const several = hasSeveralRevisions(timeline)
  const status = revisionStatus(timeline, clampedIndex)

  const config = useMemo(
    () => (spec ? buildChartConfig({ spec, colors }) : null),
    [spec, colors],
  )
  const rows = useMemo(() => (spec ? chartValueRows(spec) : []), [spec])

  const copyPng = useCallback(async () => {
    const chart = chartRef.current
    if (!chart || !spec) return
    try {
      // Compose onto an opaque themed backing: a transparent PNG pasted into a
      // white document renders light text on white and is unreadable.
      const source = chart.canvas
      const out = document.createElement('canvas')
      out.width = source.width
      out.height = source.height
      const ctx = out.getContext('2d')
      if (!ctx) {
        rWarn('conversation.chart', 'copy failed: no 2d context', { chart_id: timeline.chartId })
        setCopyState('failed')
        return
      }
      ctx.fillStyle = colors.containerBg
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(source, 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
      if (!blob) {
        rWarn('conversation.chart', 'copy failed: canvas produced no blob', { chart_id: timeline.chartId })
        setCopyState('failed')
        return
      }
      const ok = await window.ion.copyPngToClipboard(await blob.arrayBuffer())
      setCopyState(ok ? 'copied' : 'failed')
      rInfo('conversation.chart', 'chart copied', {
        chart_id: timeline.chartId,
        revision: revision?.revision ?? 0,
        bytes: blob.size,
        copied: ok,
      })
    } catch (err) {
      setCopyState('failed')
      rError('conversation.chart', 'chart copy threw', {
        chart_id: timeline.chartId, error: String(err),
      })
    }
    setTimeout(() => setCopyState('idle'), 1600)
  }, [spec, colors.containerBg, timeline.chartId, revision?.revision])

  if (!spec || !config) {
    // A timeline with no renderable revision should never reach here (the
    // derivation drops those rows), so log rather than render an empty frame.
    rWarn('conversation.chart', 'card received no renderable revision', { chart_id: timeline.chartId })
    return null
  }

  const statusLabel = status === 'current' ? 'Current' : status === 'outdated' ? 'Outdated' : null

  return (
    <div
      data-testid="chart-output-card"
      // Distinct from the moved marker's data-chart-id. Both carry the chart's
      // id — the marker so a click can route to the current revision — so a
      // jump that queried on the id alone matched whichever came FIRST in the
      // document, which is the marker. This attribute names the card itself.
      data-chart-card={timeline.chartId}
      data-chart-id={timeline.chartId}
      data-chart-revision={revision.revision}
      className="mt-1 mb-1 rounded"
      style={{
        border: `1px solid ${status === 'outdated' ? colors.statusWarning : colors.borderSubtle}`,
        background: colors.surfacePrimary,
        padding: 10,
        maxWidth: 720,
      }}
    >
      {/* Header: title, provenance, revision chrome, copy */}
      <div className="flex items-start gap-2" style={{ marginBottom: 6 }}>
        <div className="min-w-0 flex-1">
          <div
            className="truncate"
            style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}
          >
            {spec.title}
          </div>
          {spec.subtitle && (
            <div className="truncate" style={{ fontSize: 10, color: colors.textTertiary }}>
              {spec.subtitle}
            </div>
          )}
        </div>

        {statusLabel && (
          <span
            data-testid="chart-revision-status"
            style={{
              fontSize: 9,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              padding: '2px 6px',
              borderRadius: 3,
              flexShrink: 0,
              color: status === 'outdated' ? colors.statusWarning : colors.statusComplete,
              background: status === 'outdated' ? colors.statusErrorBg : colors.statusCompleteBg,
            }}
          >
            {statusLabel}
          </span>
        )}

        {several && (
          <div className="flex items-center gap-1" style={{ flexShrink: 0 }}>
            <Tooltip text="Previous revision">
              <button
                data-testid="chart-prev-revision"
                aria-label="Previous revision"
                disabled={clampedIndex === 0}
                onClick={() => setPageIndex(Math.max(clampedIndex - 1, 0))}
                className="ion-focusable"
                style={{
                  background: 'none', border: 'none', padding: 2,
                  cursor: clampedIndex === 0 ? 'default' : 'pointer',
                  color: clampedIndex === 0 ? colors.textMuted : colors.textTertiary,
                }}
              >
                <CaretLeft size={11} />
              </button>
            </Tooltip>
            <span
              data-testid="chart-revision-counter"
              style={{ fontSize: 9, color: colors.textTertiary }}
              className="tabular-nums"
            >
              {clampedIndex + 1}/{timeline.revisions.length}
            </span>
            <Tooltip text="Next revision">
              <button
                data-testid="chart-next-revision"
                aria-label="Next revision"
                disabled={clampedIndex === latestIndex}
                onClick={() => setPageIndex(Math.min(clampedIndex + 1, latestIndex))}
                className="ion-focusable"
                style={{
                  background: 'none', border: 'none', padding: 2,
                  cursor: clampedIndex === latestIndex ? 'default' : 'pointer',
                  color: clampedIndex === latestIndex ? colors.textMuted : colors.textTertiary,
                }}
              >
                <CaretRight size={11} />
              </button>
            </Tooltip>
          </div>
        )}

        <Tooltip text={copyState === 'failed' ? 'Copy failed' : copyState === 'copied' ? 'Copied' : 'Copy chart as PNG'}>
          <button
            data-testid="chart-copy-png"
            aria-label="Copy chart as PNG"
            onClick={() => { void copyPng() }}
            className="ion-focusable"
            style={{
              background: 'none', border: 'none', padding: 2, cursor: 'pointer', flexShrink: 0,
              color: copyState === 'copied'
                ? colors.statusComplete
                : copyState === 'failed' ? colors.statusError : colors.textTertiary,
            }}
          >
            <Copy size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Plot */}
      <div style={{ height: CHART_HEIGHT, position: 'relative' }}>
        <Chart
          ref={chartRef}
          data-testid="chart-canvas"
          type={config.type}
          data={config.data as never}
          options={config.options as never}
          redraw={false}
        />
      </div>

      {(spec.caption || spec.source) && (
        <div style={{ marginTop: 6, fontSize: 10, color: colors.textTertiary }}>
          {spec.caption && <div>{spec.caption}</div>}
          {spec.source && <div style={{ fontStyle: 'italic' }}>{spec.source}</div>}
        </div>
      )}

      {/* Exact values */}
      <button
        data-testid="chart-toggle-table"
        onClick={() => setShowTable((open) => !open)}
        className="flex items-center gap-1 ion-focusable"
        style={{
          marginTop: 6, background: 'none', border: 'none', padding: 0,
          cursor: 'pointer', fontSize: 10, color: colors.textTertiary,
        }}
      >
        <Table size={10} />
        <span>{showTable ? 'Hide exact values' : 'Show exact values'}</span>
      </button>

      {showTable && (
        <div style={{ marginTop: 4, overflowX: 'auto' }}>
          <table
            data-testid="chart-value-table"
            style={{ fontSize: 10, borderCollapse: 'collapse', minWidth: '100%' }}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  style={{ textAlign: 'left', padding: '2px 8px 2px 0', color: colors.textTertiary, fontWeight: 600 }}
                >
                  {spec.categoryAxis?.title ?? 'Category'}
                </th>
                {spec.datasets.map((dataset) => (
                  <th
                    key={dataset.label}
                    scope="col"
                    style={{ textAlign: 'right', padding: '2px 0 2px 8px', color: colors.textTertiary, fontWeight: 600 }}
                  >
                    {dataset.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    style={{ textAlign: 'left', padding: '2px 8px 2px 0', color: colors.textSecondary, fontWeight: 400 }}
                  >
                    {row.label}
                  </th>
                  {row.values.map((value) => (
                    <td
                      key={value.series}
                      className="tabular-nums"
                      style={{ textAlign: 'right', padding: '2px 0 2px 8px', color: colors.textPrimary }}
                    >
                      {value.display}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
})
