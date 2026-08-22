import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileText, Image, FileCode, File, FilePdf } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { useImageDataUrl } from './ImageViewer'
import type { FileAttachment } from '../../shared/types'

const ATTACHMENT_CARD_WIDTH = 160
const ATTACHMENT_PREVIEW_HEIGHT = 104

function fileIcon(mimeType: string | undefined, size: number): React.ReactNode {
  if (mimeType?.startsWith('image/')) return <Image size={size} />
  if (mimeType === 'application/pdf') return <FilePdf size={size} />
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return <FileText size={size} />
  }
  if (mimeType === 'application/json' || mimeType === 'text/yaml' || mimeType === 'text/toml') {
    return <FileCode size={size} />
  }
  return <File size={size} />
}

/** Image previews load from persisted attachment data first, then from disk. */
function AttachmentImagePreview({ attachment }: { attachment: FileAttachment }) {
  const colors = useColors()
  const dataUrl = useImageDataUrl(attachment.path, attachment.dataUrl)

  if (!dataUrl) {
    return (
      <div
        data-testid="attachment-image-placeholder"
        className="flex items-center justify-center w-full"
        style={{ height: ATTACHMENT_PREVIEW_HEIGHT, color: colors.textTertiary }}
      >
        <Image size={32} />
      </div>
    )
  }

  return (
    <img
      data-testid="attachment-image-preview"
      src={dataUrl}
      alt={attachment.name}
      className="block w-full"
      style={{ height: ATTACHMENT_PREVIEW_HEIGHT, objectFit: 'contain' }}
    />
  )
}

function AttachmentFilePreview({ attachment }: { attachment: FileAttachment }) {
  const colors = useColors()
  return (
    <div
      data-testid="attachment-file-preview"
      className="flex items-center justify-center w-full"
      style={{ height: ATTACHMENT_PREVIEW_HEIGHT, color: colors.textTertiary }}
    >
      {fileIcon(attachment.mimeType, 42)}
    </div>
  )
}

/** Remove control stays visible, keyboard reachable, and owns its interaction hook. */
function AttachmentRemoveButton({
  attachmentName,
  colors,
  onRemove,
}: {
  attachmentName: string
  colors: ReturnType<typeof useColors>
  onRemove: () => void
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      {...handlers}
      type="button"
      aria-label={`Remove ${attachmentName}`}
      onClick={onRemove}
      className="ion-focusable absolute flex items-center justify-center rounded-full"
      style={{
        top: 6,
        right: 6,
        width: 24,
        height: 24,
        color: colors.dangerFg,
        background: interactiveBg(colors, { hover, pressed }),
        border: `1px solid ${colors.surfaceSecondary}`,
        transition: `background ${transitions.base}, box-shadow ${transitions.base}`,
      }}
    >
      <X size={14} weight="bold" />
    </button>
  )
}

function AttachmentCard({ attachment, onRemove }: { attachment: FileAttachment; onRemove: (id: string) => void }) {
  const colors = useColors()
  const isImage = attachment.type === 'image'

  return (
    <motion.div
      layout
      data-testid="attachment-card"
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ duration: 0.12 }}
      className="relative flex-shrink-0 overflow-hidden"
      style={{
        width: ATTACHMENT_CARD_WIDTH,
        background: colors.surfacePrimary,
        border: `1px solid ${colors.surfaceSecondary}`,
        borderRadius: 14,
      }}
    >
      <div className="flex items-center justify-center" style={{ background: colors.surfaceSecondary }}>
        {isImage ? <AttachmentImagePreview attachment={attachment} /> : <AttachmentFilePreview attachment={attachment} />}
      </div>
      <div className="flex items-center" style={{ minHeight: 32, padding: '6px 8px' }}>
        <span
          className="text-[11px] font-medium truncate w-full"
          aria-label={attachment.name}
          style={{ color: colors.textPrimary }}
        >
          {attachment.name}
        </span>
      </div>
      <AttachmentRemoveButton attachmentName={attachment.name} colors={colors} onRemove={() => onRemove(attachment.id)} />
    </motion.div>
  )
}

/** Prominent, horizontally scrolling preview rail for attachments queued to send. */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: FileAttachment[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null

  return (
    <div
      data-ion-ui
      data-testid="attachment-preview-rail"
      className="flex gap-2"
      style={{ overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 2 }}
    >
      <AnimatePresence mode="popLayout">
        {attachments.map((attachment) => (
          <AttachmentCard key={attachment.id} attachment={attachment} onRemove={onRemove} />
        ))}
      </AnimatePresence>
    </div>
  )
}
