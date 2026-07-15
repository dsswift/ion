import React, { useState } from 'react'
import { useColors } from '../../theme'
import { ImageViewer, useImageDataUrl } from '../ImageViewer'
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
 * Renders image attachments as inline thumbnails above the user-message bubble.
 * Clicking opens an ImageViewer floating panel with save-as and reveal actions.
 */
export function InlineMessageImages({ content, attachments, align = 'end' }: { content: string; attachments?: Attachment[]; align?: 'start' | 'end' }) {
  const images = deriveMessageImages(content, attachments)
  const [previewImage, setPreviewImage] = useState<{ path: string; name: string } | null>(null)

  if (images.length === 0) return null

  return (
    <>
      <div className={`flex flex-col gap-1 mb-1 ${align === 'end' ? 'items-end' : 'items-start'}`}>
        {images.map((img) => (
          <InlineImage
            key={img.key}
            path={img.path}
            name={img.name}
            dataUrl={img.dataUrl}
            onPreview={() => setPreviewImage({ path: img.path, name: img.name })}
          />
        ))}
      </div>
      {previewImage && (
        <ImageViewer
          filePath={previewImage.path}
          fileName={previewImage.name}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  )
}

function InlineImage({ path, name, dataUrl: initialDataUrl, onPreview }: { path: string; name: string; dataUrl?: string; onPreview: () => void }) {
  const colors = useColors()
  const dataUrl = useImageDataUrl(path, initialDataUrl)

  if (!dataUrl) {
    return (
      <div
        className="text-[11px] px-2 py-1 rounded"
        style={{ background: colors.surfacePrimary, color: colors.textTertiary, border: `1px solid ${colors.surfaceSecondary}` }}
        title={path}
      >
        {name}
      </div>
    )
  }

  return (
    <button
      type="button"
      className="block rounded-lg overflow-hidden border cursor-pointer"
      style={{ borderColor: colors.toolBorder, background: colors.surfacePrimary, maxWidth: 280 }}
      onClick={onPreview}
      title={name}
    >
      <img
        src={dataUrl}
        alt={name}
        className="block w-full max-h-[260px] object-contain"
        loading="lazy"
      />
    </button>
  )
}
