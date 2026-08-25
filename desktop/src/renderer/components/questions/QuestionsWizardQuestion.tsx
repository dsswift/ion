import React from 'react'
import type { useColors } from '../../theme'
import type { QuestionSpec } from '../../../shared/questions-schema'
import { resolveQuestionDisplay } from '../../../shared/questions-schema'
import type { QuestionDraftAnswer } from '../../../shared/questions-state'
import { AutoGrowTextarea } from './AutoGrowTextarea'
import { QuestionAttachmentRow } from './QuestionAttachmentRow'

/**
 * One question's answer control inside the QuestionsWizard: radio rows or
 * pill groups (single), checkbox rows or pill groups (multiple), or a
 * free-form text field (text mode). Option questions always render the
 * "Other" free-text input alongside the options — the model never has to
 * declare an Other option. Purely presentational: every change calls
 * onChange with the full replacement draft answer; the wizard owns
 * persistence through main IPC.
 */
export function QuestionsWizardQuestion({
  spec,
  draft,
  onChange,
  colors,
}: {
  spec: QuestionSpec
  draft: QuestionDraftAnswer
  onChange: (next: QuestionDraftAnswer) => void
  colors: ReturnType<typeof useColors>
}): React.JSX.Element {
  const skipped = draft.skipped === true

  const toggleOption = (optionId: string) => {
    if (spec.mode === 'single') {
      const selected = draft.selectedOptionIds.includes(optionId) ? [] : [optionId]
      onChange({ ...draft, selectedOptionIds: selected, skipped: undefined })
      return
    }
    const has = draft.selectedOptionIds.includes(optionId)
    const selected = has
      ? draft.selectedOptionIds.filter((id) => id !== optionId)
      : [...draft.selectedOptionIds, optionId]
    onChange({ ...draft, selectedOptionIds: selected, skipped: undefined })
  }

  const setCustomText = (text: string) => {
    onChange({ ...draft, customText: text || undefined, skipped: undefined })
  }

  const toggleSkip = () => {
    onChange(
      skipped
        ? { ...draft, skipped: undefined }
        : { questionId: draft.questionId, selectedOptionIds: [], skipped: true },
    )
  }

  return (
    <div className="mb-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-[1.4]" style={{ color: colors.textPrimary }}>
          {spec.prompt}
        </p>
        <button
          onClick={toggleSkip}
          className="text-[10px] px-2 py-0.5 rounded-full shrink-0 cursor-pointer transition-colors"
          style={{
            background: skipped ? colors.infoBg : colors.surfaceHover,
            color: skipped ? colors.infoText : colors.textTertiary,
            border: `1px solid ${skipped ? colors.infoBorder : colors.surfaceSecondary}`,
          }}
        >
          {skipped ? 'Agent decides ✓' : 'Agent decides'}
        </button>
      </div>
      {spec.guidance && (
        <p className="text-[11px] leading-[1.4] mt-0.5 mb-1" style={{ color: colors.textTertiary }}>
          {spec.guidance}
        </p>
      )}
      {!skipped && (
        <div className="mt-1.5">
          {spec.mode === 'text' ? (
            <AutoGrowTextarea
              value={draft.customText ?? ''}
              onChange={setCustomText}
              placeholder="Type your answer…"
              colors={colors}
              emphasized
            />
          ) : (
            <OptionControl spec={spec} draft={draft} onToggle={toggleOption} onCustomText={setCustomText} colors={colors} />
          )}
          <QuestionAttachmentRow draft={draft} onChange={onChange} colors={colors} />
        </div>
      )}
    </div>
  )
}

function OptionControl({
  spec,
  draft,
  onToggle,
  onCustomText,
  colors,
}: {
  spec: QuestionSpec
  draft: QuestionDraftAnswer
  onToggle: (optionId: string) => void
  onCustomText: (text: string) => void
  colors: ReturnType<typeof useColors>
}): React.JSX.Element {
  const display = resolveQuestionDisplay(spec)
  const options = spec.options ?? []

  return (
    <div>
      {display === 'pills' ? (
        <div className="flex gap-1.5 flex-wrap">
          {options.map((opt) => {
            const selected = draft.selectedOptionIds.includes(opt.id)
            return (
              <button
                key={opt.id}
                onClick={() => onToggle(opt.id)}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                style={{
                  background: selected ? colors.infoText : colors.infoBg,
                  color: selected ? colors.containerBg : colors.infoText,
                  border: `1px solid ${colors.infoBorder}`,
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {options.map((opt) => {
            const selected = draft.selectedOptionIds.includes(opt.id)
            return (
              <button
                key={opt.id}
                onClick={() => onToggle(opt.id)}
                className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer"
                style={{
                  background: selected ? colors.infoBg : colors.surfaceHover,
                  border: `1px solid ${selected ? colors.infoBorder : colors.surfaceSecondary}`,
                }}
              >
                <span
                  className="mt-[2px] shrink-0 inline-block w-3.5 h-3.5"
                  style={{
                    borderRadius: display === 'radio' ? '50%' : 4,
                    border: `1.5px solid ${selected ? colors.infoText : colors.textTertiary}`,
                    background: selected ? colors.infoText : 'transparent',
                  }}
                />
                <span className="flex-1">
                  <span className="block text-[12px] font-medium" style={{ color: selected ? colors.infoText : colors.textPrimary }}>
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="block text-[11px] leading-[1.4] mt-0.5" style={{ color: colors.textTertiary }}>
                      {opt.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {/* Always-visible Other input on option questions. Auto-grows 1→4
          rows and wraps — a long custom answer must never scroll sideways. */}
      <div className="mt-1.5">
        <AutoGrowTextarea
          value={draft.customText ?? ''}
          onChange={onCustomText}
          placeholder={spec.mode === 'single' ? 'Other…' : 'Other (add your own)…'}
          colors={colors}
        />
      </div>
    </div>
  )
}
