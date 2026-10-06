import React from 'react'
import { Paperclip, X } from '@phosphor-icons/react'
import { rWarn } from '../../rendererLogger'
import type { useColors } from '../../theme'
import type { QuestionDraftAnswer, QuestionsWorkflowState } from '@ion/shared/questions-state'
import { environmentOfWorkflow } from '../../stores/questions-store'
import { stageFilesFor } from '../composer/attachment-staging'
import { pickLocalFiles } from '../composer/local-file-sources'

/**
 * Per-question attachment row: an "Attach image" affordance plus removable
 * chips for the images already attached to this answer. The operator picks
 * images from their own machine; each is staged on the Environment holding
 * the workflow (by path when it is this desktop, uploaded otherwise), and
 * at submit the resume prompt's attachment pipeline delivers the bytes to
 * the engine.
 */
export function QuestionAttachmentRow({
  workflow,
  draft,
  onChange,
  colors,
}: {
  workflow: Pick<QuestionsWorkflowState, 'workflowId' | 'sessionKey'>
  draft: QuestionDraftAnswer
  onChange: (next: QuestionDraftAnswer) => void
  colors: ReturnType<typeof useColors>
}): React.JSX.Element {
  const attachments = draft.attachments ?? []

  const pick = () => {
    const target = { tabId: workflow.sessionKey, environmentId: environmentOfWorkflow(workflow.workflowId) }
    void pickLocalFiles({ accept: 'image/*' })
      .then((files) => stageFilesFor(files, 'pick', target))
      .then((staged) => {
        if (staged.length === 0) return
        // De-duplicate by path; re-picking an attached file is a no-op.
        const existing = new Set(attachments.map((a) => a.path))
        const added = staged
          .filter((a) => !existing.has(a.path))
          .map((a) => ({ path: a.path, name: a.name }))
        if (added.length === 0) return
        onChange({ ...draft, attachments: [...attachments, ...added], skipped: undefined })
      })
      .catch((err: unknown) => rWarn('questions', 'attachment pick failed', { workflow_id: workflow.workflowId, error: String(err) }))
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
