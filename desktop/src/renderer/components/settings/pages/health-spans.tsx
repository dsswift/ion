/**
 * health-spans — the Health page's live list of this window's render-side
 * spans (`lib/span-writer.ts`): the last few `transcript.apply`,
 * `store.hydrate`, `body.load`, `studio.first_paint`, `prompt.visible`, and
 * `terminal.echo` records, newest first, read from the window-local ring the
 * span writer keeps. No request is made: what is shown is what this window
 * measured.
 */
import React, { useSyncExternalStore } from 'react'
import type { SpanRecord } from '@ion/shared/trace-context'
import { recentRendererSpans, subscribeRendererSpans } from '../../../lib/span-writer'
import { CellText, DataList, Muted } from '../kit'

/** The spans the list shows: what this window renders and hydrates. */
export const RENDER_SPAN_NAMES: ReadonlySet<string> = new Set(['transcript.apply', 'store.hydrate', 'body.load', 'studio.first_paint', 'prompt.visible', 'terminal.echo'])

export function renderSpans(records: readonly SpanRecord[]): SpanRecord[] {
  return records.filter((r) => RENDER_SPAN_NAMES.has(r.name))
}

function detail(r: SpanRecord): string {
  const a = r.attributes
  const parts: string[] = []
  if (typeof a.tab_id === 'string') parts.push(`tab ${a.tab_id.slice(0, 8)}`)
  if (typeof a.deltas === 'number') parts.push(`${a.deltas} delta${a.deltas === 1 ? '' : 's'}`)
  if (typeof a.row_count === 'number') parts.push(`${a.row_count} rows`)
  if (typeof a.tab_count === 'number') parts.push(`${a.tab_count} tabs`)
  if (r.error) parts.push(r.error)
  return parts.join(' · ')
}

export function useRenderSpans(): SpanRecord[] {
  const all = useSyncExternalStore(subscribeRendererSpans, recentRendererSpans, recentRendererSpans)
  return renderSpans(all)
}

/** The render-timing list. Empty until this window has measured something. */
export function RenderTimingList(): React.JSX.Element {
  const rows = useRenderSpans()
  return (
    <DataList
      label="Render timing"
      title="Render timing"
      description="What this window measured between a byte arriving and a pixel changing, newest first."
      anchor="render-timing"
      items={rows}
      getKey={(r) => r.spanId}
      columns={[
        { id: 'name', header: 'Span', width: '140px', render: (r) => <CellText>{r.name}</CellText> },
        { id: 'duration', header: 'Duration', width: '72px', align: 'end', render: (r) => `${Math.round(r.durationMs)} ms` },
        { id: 'detail', header: 'Detail', width: 'minmax(0, 1fr)', render: (r) => <Muted>{detail(r)}</Muted> },
      ]}
      noun={['span', 'spans']}
      loading={false}
      showHeader
    />
  )
}
