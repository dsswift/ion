import React, { useMemo } from 'react'
import { File, FileText } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { Attachment } from '@ion/shared/types'
import { useColors } from '../../theme'
import { useInteractiveState } from '../../hooks/useInteractiveState'
import { attachmentOpenKind, openAttachment, type OpenableAttachment } from '../../lib/open-attachment'
import { rError } from '../../rendererLogger'

const ATTACHED_FILE_RE = /^\[Attached file: ([^\]]+)\]$/gm

/**
 * Document attachments sent with a user message: the explicit `attachments`
 * array plus any `[Attached file: PATH]` marker in the text. The marker pass
 * keeps the chip after a reload that dropped the array; its name is then the
 * stored file's own.
 */
export function deriveMessageFiles(content: string, attachments?: Attachment[]): Array<OpenableAttachment & { key: string }> {
  const out: Array<OpenableAttachment & { key: string }> = []
  const seen = new Set<string>()
  for (const a of attachments ?? []) {
    if (a.type !== 'file' || !a.path || seen.has(a.path)) continue
    seen.add(a.path)
    out.push({ key: a.id, path: a.path, name: a.name })
  }
  for (const m of (content || '').matchAll(ATTACHED_FILE_RE)) {
    const path = m[1].trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ key: `marker:${path}`, path, name: path.split('/').pop() || path })
  }
  return out
}

function FileChip({ file, tabId }: { file: OpenableAttachment; tabId: string | undefined }) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const Icon = attachmentOpenKind(file) === 'text' ? FileText : File
  const open = (): void => {
    const target = tabId ?? useSessionStore.getState().activeTabId
    if (!target) return
    void openAttachment(target, file).catch((err) => rError('attachments', 'open message attachment failed', { path: file.path, error: String(err) }))
  }
  return (
    <button
      type="button"
      onClick={open}
      {...handlers}
      title={file.name}
      data-message-file-chip
      className="inline-flex items-center gap-1.5 min-w-0 ion-focusable"
      style={{
        maxWidth: 240,
        padding: '3px 9px',
        borderRadius: 10,
        fontSize: 11,
        cursor: 'pointer',
        color: colors.textSecondary,
        background: pressed ? colors.surfacePressed : hover ? colors.surfaceHover : colors.surfacePrimary,
        border: `1px solid ${colors.userBubbleBorder}`,
      }}
    >
      <Icon size={13} className="flex-shrink-0" style={{ color: colors.textTertiary }} />
      <span className="truncate">{file.name}</span>
    </button>
  )
}

/**
 * The documents a user message was sent with, as chips above its bubble.
 * Clicking one opens it the way the attachments panel does: in Ion when Ion
 * can show it, otherwise in the operator's own application.
 */
export function MessageFileChips({ content, attachments, tabId }: { content: string; attachments?: Attachment[]; tabId?: string }) {
  const files = useMemo(() => deriveMessageFiles(content, attachments), [content, attachments])
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap justify-end gap-1 pb-1 max-w-full" data-message-file-chips>
      {files.map((file) => <FileChip key={file.key} file={file} tabId={tabId} />)}
    </div>
  )
}
