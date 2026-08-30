import React, { useMemo } from 'react'
import { deriveMessageImages } from './InlineMessageImages'
import { ImageGallery, type GalleryImage } from './ImageGallery'
import { ChartOutputCard } from './ChartOutputCard'
import { ChartMovedMarker } from './ChartMovedMarker'
import type { ChartRenderIndex } from './chart-revisions'
import { rInfo } from '../../rendererLogger'
import type { Message } from '../../../shared/types'

/**
 * ToolVisualOutputs — the always-visible deliverables a group of tool rows
 * produced: images and Chart Outputs.
 *
 * ── Why anything renders outside the collapsed panel ────────────────────────
 * Tool rows live inside ToolGroup / AgentTurnGroup, and both collapse their
 * tool panel by default. A tool's TEXT result (stdout, file contents) is
 * verbose and belongs behind that collapse. A tool's VISUAL result is the
 * answer itself: an image or a chart buried behind "Used N tools" is, for the
 * user, simply missing. This component is the single seam that paints them,
 * unconditionally. (Regression history: #224, where 20 restored images never
 * appeared because only the collapsed row rendered them.)
 *
 * ── Why images and charts share one component ───────────────────────────────
 * They obey the same rule and sit in the same place, so one seam means one set
 * of mount points to keep correct. Four separate hoists — the number that
 * existed for images alone — is exactly how the duplicate-render bug below
 * survived unnoticed.
 *
 * ── `owned` and the duplicate-render fix ────────────────────────────────────
 * AgentTurnGroup renders this component AND mounts an embedded ToolGroup for
 * the same rows. Before `owned`, the embedded group painted its own copy of
 * every image, so expanding a unified turn showed each image twice. The turn
 * container now declares ownership and the embedded group renders nothing
 * visual — one owner per row, always.
 */
export const ToolVisualOutputs = React.memo(function ToolVisualOutputs({
  tools,
  chartRenders,
  tabId,
  owned = true,
}: {
  /** The tool rows this group renders. */
  tools: Message[]
  /**
   * Per-row chart render state, derived ONCE by the transcript from the whole
   * conversation (a chart's current revision usually lives in a different
   * group than the row being rendered). A prepared index rather than the raw
   * message list, so a row's memo depends on its own chart entry alone.
   */
  chartRenders?: ChartRenderIndex
  tabId?: string
  /**
   * False when an ancestor already renders this group's visual output. Set by
   * the embedded ToolGroup inside AgentTurnGroup.
   */
  owned?: boolean
}) {
  // Tool images arrive exclusively as FileAttachment objects placed by
  // event-slice-images.ts (engine_image_content → attachImageToMessages).
  // We intentionally pass '' for content so the text is never regex-scanned
  // for [Attached image: PATH] markers — tool result content is arbitrary
  // program output and can contain that pattern by coincidence (e.g. a Bash
  // tool that runs tests containing the string in fixture data). Scanning it
  // produces false-positive image pills from paths that don't exist and were
  // never meant to be images. The content-scan path in deriveMessageImages is
  // for user message restoration only.
  //
  // Single pass over `tools`: derive each row's images once, fold them into
  // the flattened gallery list, and count rows-with-images alongside it.
  // Memoized on [tools] because ImageGallery's IntersectionObserver effect and
  // its `siblings` memo both key on this array's identity, and this component
  // sits on the streaming transcript's hot path.
  const { items, rows } = useMemo(() => {
    const flattened: GalleryImage[] = []
    let rowsWithImages = 0
    for (const tool of tools) {
      const images = deriveMessageImages('', tool.attachments)
      if (images.length === 0) continue
      rowsWithImages += 1
      for (const img of images) {
        flattened.push({ ...img, key: `${tool.id}:${img.key}`, caption: tool.toolName })
      }
    }
    return { items: flattened, rows: rowsWithImages }
  }, [tools])

  // The transcript derived chart state once for the whole conversation; this
  // group renders only the entries its own rows own. Reading from a prepared
  // index (instead of re-deriving from the full message list here) is what
  // keeps each row's memo dependent on its own chart entry alone.
  const charts = useMemo(() => {
    if (!chartRenders) return []
    const owned: Array<{ messageId: string; render: NonNullable<ReturnType<ChartRenderIndex['get']>> }> = []
    for (const tool of tools) {
      const render = chartRenders.get(tool.id)
      if (render) owned.push({ messageId: tool.id, render })
    }
    return owned
  }, [tools, chartRenders])

  if (!owned) return null
  if (items.length === 0 && charts.length === 0) return null

  // Observability: a render with zero painted deliverables despite attachments
  // in the store would be a regression of the exact #224 defect. Log the count
  // so the NEXT failure is diagnosable from desktop.jsonl alone.
  if (items.length > 0) {
    rInfo('conversation', 'rendering tool image strip', { rows, images: items.length })
  }
  if (charts.length > 0) {
    rInfo('conversation', 'rendering chart outputs', {
      charts: charts.length,
      current: charts.filter((entry) => entry.render.kind === 'current').length,
    })
  }

  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      {items.length > 0 && <ImageGallery items={items} align="start" />}
      {charts.map(({ messageId, render }) => (
        render.kind === 'current'
          ? <ChartOutputCard key={messageId} timeline={render.timeline} />
          : (
            <ChartMovedMarker
              key={messageId}
              chartId={render.chartId}
              title={render.title}
              targetMessageId={render.targetMessageId}
              tabId={tabId}
            />
          )
      ))}
    </div>
  )
})
