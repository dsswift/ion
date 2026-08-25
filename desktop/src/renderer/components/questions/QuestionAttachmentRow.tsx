import React from 'react'
import { Paperclip, X } from '@phosphor-icons/react'
import { rWarn } from '../../rendererLogger'
import type { useColors } from '../../theme'
import type { QuestionDraftAnswer, QuestionAnswerAttachment } from '../../../shared/questions-state'

/**
 * Per-question attachment row: an "Attach image" affordance plus removable
 * chips for the images already attached to this answer. Selection goes
 * through the main-process native picker (QUESTIONS_PICK_ATTACHMENTS);
 * the picked paths ride the draft answer and, at submit, the resume
 * prompt's attachment pipeline delivers the bytes to the engine.
 */
export function QuestionAttachmentRow({
  draft,
  onChange,
  colors,
}: {
  draft: QuestionDraftAnswer
  onChange: (next: QuestionDraftAnswer) => void
  colors: ReturnType<typeof useColors>
}): React.JSX.Element {
  const attachments = draft.attachments ?? []

  const pick = () => {
    void window.ion
      .questionsPickAttachments()
      .then((picked: QuestionAnswerAttachment[]) => {
        if (picked.length === 0) return
        // De-duplicate by path; re-picking an attached file is a no-op.
        const existing = new Set(attachments.map((a) => a.path))
        const added = picked.filter((p) => !existing.has(p.path))
        if (added.length === 0) return
        onChange({ ...draft, attachments: [...attachments, ...added], skipped: undefined })
      })
      .catch((err: unknown) => rWarn('questions', 'attachment pick failed', { error: String(err) }))
  }

  const remove = (path: string) => {
    const next = attachments.filter((a) => a.path !== path)
    onChange({ ...draft, attachments: next.length > 0 ? next : undefined })
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
      <button
        onClick={pick}
        className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full cursor-pointer transition-colors"
        style={{
          background: colors.surfaceHover,
          color: colors.textTertiary,
          border: `1px solid ${colors.surfaceSecondary}`,
        }}
      >
        <Paperclip size={11} />
        Attach image
      </button>
      {attachments.map((att) => (
        <span
          key={att.path}
          className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full max-w-[180px]"
          style={{
            background: colors.infoBg,
            color: colors.infoText,
            border: `1px solid ${colors.infoBorder}`,
          }}
        >
          <span className="truncate">{att.name}</span>
          <button
            onClick={() => remove(att.path)}
            className="shrink-0 cursor-pointer"
            style={{ color: colors.infoText }}
            aria-label={`Remove ${att.name}`}
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}
