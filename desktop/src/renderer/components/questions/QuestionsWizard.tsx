import React, { useEffect, useRef, useState } from 'react'
import { useColors } from '../../theme'
import { rWarn } from '../../rendererLogger'
import type { QuestionsWorkflowState, QuestionDraftAnswer } from '../../../shared/questions-state'
import { QuestionsWizardQuestion } from './QuestionsWizardQuestion'
import { AutoGrowTextarea } from './AutoGrowTextarea'

/**
 * QuestionsWizard — the ONE guided-questions body, mounted by the Overlay
 * modal and the Studio QuestionsSurface alike (parity by construction).
 *
 * Renders the workflow's current phase: the answer form (collecting), the
 * review screen (review), and the waiting states (submitting /
 * awaiting_next). All mutations are revisioned main IPC calls; local edit
 * state exists only to keep typing responsive between debounced patches —
 * the broadcast state replaces it whenever main accepts or rejects.
 */
export function QuestionsWizard({ workflow }: { workflow: QuestionsWorkflowState }): React.JSX.Element {
  const colors = useColors()
  // Local draft mirror for responsive typing; re-seeded whenever main's
  // revision advances (acceptance or rollback).
  const [draft, setDraft] = useState<QuestionDraftAnswer[]>(workflow.draft)
  const [comment, setComment] = useState(workflow.comment ?? '')
  const seenRevision = useRef(workflow.revision)
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (workflow.revision !== seenRevision.current) {
      seenRevision.current = workflow.revision
      setDraft(workflow.draft)
      setComment(workflow.comment ?? '')
    }
  }, [workflow.revision, workflow.draft, workflow.comment])

  // Debounced draft patch: coalesce keystrokes; one patch in flight at a time
  // (the revision CAS makes overlapping sends safe — a stale one rolls back).
  const schedulePatch = (answers: QuestionDraftAnswer[], pageComment: string) => {
    if (patchTimer.current) clearTimeout(patchTimer.current)
    patchTimer.current = setTimeout(() => {
      void window.ion
        .questionsPatch({
          workflowId: workflow.workflowId,
          requestId: workflow.requestId,
          expectedRevision: seenRevision.current,
          actionId: crypto.randomUUID(),
          answers,
          comment: pageComment,
        })
        .catch((err: unknown) => rWarn('questions', 'patch failed', { error: String(err) }))
    }, 250)
  }

  const updateAnswer = (next: QuestionDraftAnswer) => {
    const answers = draft.map((d) => (d.questionId === next.questionId ? next : d))
    setDraft(answers)
    schedulePatch(answers, comment)
  }

  const updateComment = (text: string) => {
    setComment(text)
    schedulePatch(draft, text)
  }

  const sendAction = (kind: 'enter_review' | 'edit_question' | 'request_more' | 'final_confirm') => {
    // ONE atomic call: the action carries the final local draft inline, so
    // the draft flush and the transition land in a single revision step.
    // (The old two-call chain — patch, then an action that GUESSED the
    // post-patch revision — raced the debounced patch and made "Review
    // answers" a stale-CAS no-op.)
    if (patchTimer.current) {
      clearTimeout(patchTimer.current)
      patchTimer.current = null
    }
    void window.ion
      .questionsAction({
        workflowId: workflow.workflowId,
        requestId: workflow.requestId,
        expectedRevision: seenRevision.current,
        actionId: crypto.randomUUID(),
        kind,
        answers: draft,
        comment,
      })
      .then((result) => {
        if (!result.accepted) rWarn('questions', 'action rejected', { kind, error: result.error })
      })
      .catch((err: unknown) => rWarn('questions', 'action failed', { kind, error: String(err) }))
  }

  if (workflow.phase === 'submitting' || workflow.phase === 'awaiting_next') {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-[13px] font-medium" style={{ color: colors.textPrimary }}>
          {workflow.phase === 'submitting' ? 'Sending your answers…' : 'Preparing more questions…'}
        </p>
        <p className="text-[11px] mt-1" style={{ color: colors.textTertiary }}>
          {workflow.phase === 'submitting'
            ? 'The agent is receiving this page.'
            : 'The agent is writing the next round on this topic.'}
        </p>
      </div>
    )
  }

  if (workflow.phase === 'review') {
    return <ReviewScreen workflow={workflow} colors={colors} onAction={sendAction} />
  }

  // collecting
  return (
    <div className="px-4 py-3">
      {workflow.request.description && (
        <p className="text-[12px] leading-[1.5] mb-3" style={{ color: colors.textSecondary }}>
          {workflow.request.description}
        </p>
      )}
      {workflow.request.questions.map((q) => {
        const answer = draft.find((d) => d.questionId === q.id) ?? { questionId: q.id, selectedOptionIds: [] }
        return <QuestionsWizardQuestion key={q.id} spec={q} draft={answer} onChange={updateAnswer} colors={colors} />
      })}
      <div className="mb-3">
        <AutoGrowTextarea
          value={comment}
          onChange={updateComment}
          placeholder="Anything else? (optional page comment)"
          colors={colors}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <WizardButton label="Ask me more questions" subdued colors={colors} onClick={() => sendAction('request_more')} />
        <WizardButton label="Review answers" colors={colors} onClick={() => sendAction('enter_review')} />
      </div>
    </div>
  )
}

function ReviewScreen({
  workflow,
  colors,
  onAction,
}: {
  workflow: QuestionsWorkflowState
  colors: ReturnType<typeof useColors>
  onAction: (kind: 'edit_question' | 'request_more' | 'final_confirm') => void
}): React.JSX.Element {
  return (
    <div className="px-4 py-3">
      <p className="text-[12px] font-semibold mb-2" style={{ color: colors.textPrimary }}>
        Review your answers
      </p>
      {workflow.history.length > 0 && (
        <p className="text-[11px] mb-2" style={{ color: colors.textTertiary }}>
          {workflow.history.length} earlier page{workflow.history.length === 1 ? '' : 's'} already submitted in this round.
        </p>
      )}
      <div className="flex flex-col gap-2 mb-3">
        {workflow.request.questions.map((q) => {
          const answer = workflow.draft.find((d) => d.questionId === q.id)
          const labels = (answer?.selectedOptionIds ?? []).map(
            (id) => q.options?.find((o) => o.id === id)?.label ?? id,
          )
          const parts = [...labels]
          if (answer?.customText) parts.push(answer.customText)
          if (answer?.attachments?.length) parts.push(`${answer.attachments.length} image${answer.attachments.length === 1 ? '' : 's'} attached`)
          const summary = answer?.skipped || parts.length === 0 ? 'Agent decides' : parts.join(', ')
          return (
            <div
              key={q.id}
              className="px-2.5 py-1.5 rounded-lg"
              style={{ background: colors.surfaceHover, border: `1px solid ${colors.surfaceSecondary}` }}
            >
              <p className="text-[11px] font-medium" style={{ color: colors.textSecondary }}>{q.prompt}</p>
              <p className="text-[12px] mt-0.5" style={{ color: answer?.skipped || parts.length === 0 ? colors.textTertiary : colors.textPrimary }}>
                {summary}
              </p>
            </div>
          )
        })}
        {workflow.comment && (
          <div
            className="px-2.5 py-1.5 rounded-lg"
            style={{ background: colors.surfaceHover, border: `1px solid ${colors.surfaceSecondary}` }}
          >
            <p className="text-[11px] font-medium" style={{ color: colors.textSecondary }}>Page comment</p>
            <p className="text-[12px] mt-0.5" style={{ color: colors.textPrimary }}>{workflow.comment}</p>
          </div>
        )}
      </div>
      <div className="flex gap-2 justify-end">
        <WizardButton label="Edit" subdued colors={colors} onClick={() => onAction('edit_question')} />
        <WizardButton label="Ask me more questions" subdued colors={colors} onClick={() => onAction('request_more')} />
        <WizardButton label="Confirm & send" colors={colors} onClick={() => onAction('final_confirm')} />
      </div>
    </div>
  )
}

function WizardButton({
  label,
  onClick,
  colors,
  subdued,
}: {
  label: string
  onClick: () => void
  colors: ReturnType<typeof useColors>
  subdued?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
      style={{
        background: subdued ? colors.surfaceHover : colors.infoBg,
        color: subdued ? colors.textSecondary : colors.infoText,
        border: `1px solid ${subdued ? colors.surfaceSecondary : colors.infoBorder}`,
      }}
    >
      {label}
    </button>
  )
}
