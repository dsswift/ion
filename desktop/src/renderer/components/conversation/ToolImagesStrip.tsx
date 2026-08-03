import React, { useMemo } from 'react'
import { deriveMessageImages } from './InlineMessageImages'
import { ImageGallery, type GalleryImage } from './ImageGallery'
import { rInfo } from '../../rendererLogger'
import type { Message } from '../../../shared/types'

/**
 * ToolImagesStrip — always-visible strip of the images produced by a group of
 * tool rows.
 *
 * Why this exists (the #224 render-path gap): tool-generated images (icons,
 * logos, screenshots, diagrams a tool or dispatched agent produced) attach to
 * `role: 'tool'` messages. Those messages render only inside ToolGroup /
 * AgentTurnGroup, and BOTH collapse their tool panel by default
 * (`useState(false)`; `expandToolResults` defaults off). ToolRow — the only
 * component that renders a tool row's inline images — therefore never mounts
 * until the user manually expands the "Used N tools" header. The images are in
 * the store with the correct shape and the files exist on disk, but they are
 * buried behind a collapsed panel and never paint. The whole #224 conversation
 * (20 restored images) showed a blank transcript for exactly this reason, even
 * after the data path (persist → reconcile → merge → store) was fully fixed.
 *
 * An image is a visual deliverable, not verbose tool output. The collapse
 * governs the tool's TEXT result (stdout, file contents), not its images. So we
 * hoist every tool-row image to the group container and render it here,
 * unconditionally — visible whether or not the tool panel is expanded. ToolRow
 * no longer renders images (it would double-render when expanded); this strip
 * is the single seam that paints tool images.
 *
 * Every row's images flatten into ONE gallery for the group. Per-row galleries
 * were what made a many-image turn unusable: a group of 21 tools each holding
 * a few screens produced 21 stacked lists. One gallery gives the whole group a
 * single bounded rail. Entries are keyed `${tool.id}:${path}` and are NOT
 * deduped across rows — a path returned by two different tools stays two
 * entries, each labelled with its producing tool, preserving the owning-tool
 * association the per-row rendering carried.
 */
export const ToolImagesStrip = React.memo(function ToolImagesStrip({ tools }: { tools: Message[] }) {
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
  // the flattened gallery list, and count rows-with-images alongside it —
  // rather than a second deriveMessageImages sweep purely for the log field.
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

  if (items.length === 0) return null

  // Observability: a render with zero painted images despite attachments in the
  // store would be a regression of the exact #224 defect. Log the count so the
  // NEXT failure is diagnosable from desktop.jsonl alone (per logging policy).
  rInfo('conversation', 'rendering tool image strip', { rows, images: items.length })

  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      <ImageGallery items={items} align="start" />
    </div>
  )
})
