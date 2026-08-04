import React, { useMemo } from 'react'
import { ImageGallery } from './ImageGallery'
import type { Attachment, FileAttachment } from '../../../shared/types'

const ATTACHED_IMAGE_RE = /\[Attached image: ([^\]]+)\]/g

/**
 * Image attachment entries derived from a user message: the explicit
 * `attachments` array (when present) plus any `[Attached image: PATH]`
 * markers found in the message text. The marker pass survives a desktop
 * relaunch where the renderer's persisted state lost the attachments
 * array but the marker text in `content` was kept.
 *
 * `dataUrl` is forwarded from `FileAttachment.dataUrl` when present. This is
 * the fallback data for pasted/screenshot images whose on-disk path no longer
 * exists (pre-fix sessions wrote to tmpdir which macOS purges across reboots).
 * The render path seeds `useImageDataUrl` with it so the image renders even
 * when the file is gone.
 */
export function deriveMessageImages(content: string, attachments?: Attachment[]): Array<{ key: string; path: string; name: string; dataUrl?: string }> {
  const out: Array<{ key: string; path: string; name: string; dataUrl?: string }> = []
  const seen = new Set<string>()

  for (const a of attachments || []) {
    if (a.type !== 'image') continue
    const path = (a as FileAttachment).path
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ key: a.id, path, name: a.name, dataUrl: (a as FileAttachment).dataUrl })
  }

  for (const m of (content || '').matchAll(ATTACHED_IMAGE_RE)) {
    const path = m[1].trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    const name = path.split('/').pop() || path
    // Marker-derived entries have no persisted dataUrl — they come from content
    // text, not from the typed attachment object.
    out.push({ key: `marker:${path}`, path, name })
  }

  return out
}

/**
 * Renders a message's image attachments as an ImageGallery above the bubble.
 * One image keeps the large inline thumbnail; two or more become a paged rail
 * so a many-image turn cannot stretch the transcript. Clicking a tile opens
 * the ImageViewer floating panel with save-as, reveal, and paging.
 *
 * `images` is memoized on [content, attachments]. ImageGallery's
 * IntersectionObserver effect and its `siblings` memo both key on the
 * identity of the items array, and this component sits on the streaming
 * transcript's hot path — a parent re-render on every chunk would otherwise
 * hand the gallery a freshly allocated array each time, tearing down and
 * re-observing every visible tile and defeating the sibling memo it feeds.
 */
export function InlineMessageImages({ content, attachments, align = 'end' }: { content: string; attachments?: Attachment[]; align?: 'start' | 'end' }) {
  const images = useMemo(() => deriveMessageImages(content, attachments), [content, attachments])
  if (images.length === 0) return null
  return <ImageGallery items={images} align={align} />
}
