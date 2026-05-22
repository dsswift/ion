import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Question } from '@phosphor-icons/react'
import { useColors } from '../theme'

export interface AskOption {
  label: string
  description?: string
}

export interface AskData {
  question: string
  header?: string
  options: AskOption[]
}

/**
 * Card rendered inside PermissionDeniedCard when the engine called
 * AskUserQuestion. Shows the question text, optional multiple-choice option
 * buttons (single-tap answer), and a free-text fallback for open-ended input.
 *
 * Kept in its own file because it is a self-contained presentational component
 * with its own local state (the free-text input value) and no dependency on the
 * rest of the denial-card logic.
 */
export function AskQuestionCard({
  askData,
  onAnswer,
  onDismiss,
  colors,
}: {
  askData: AskData
  onAnswer: (answer: string) => void
  onDismiss: () => void
  colors: ReturnType<typeof useColors>
}) {
  const [freeText, setFreeText] = useState('')
  const hasOptions = askData.options.length > 0

  const handleSubmit = () => {
    const trimmed = freeText.trim()
    if (trimmed) {
      onAnswer(trimmed)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className="mx-4 mb-2"
    >
      <div
        style={{
          background: colors.containerBg,
          border: `1px solid ${colors.infoBorder}`,
          borderRadius: 14,
          boxShadow: `0 2px 12px ${colors.infoShadow}`,
        }}
        className="overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{
            background: colors.infoBg,
            borderBottom: `1px solid ${colors.infoBorder}`,
          }}
        >
          <Question size={14} style={{ color: colors.infoText }} />
          <span className="text-[12px] font-semibold" style={{ color: colors.infoText }}>
            {askData.header || 'Question'}
          </span>
        </div>

        {/* Body */}
        <div className="px-3 py-2">
          <p className="text-[12px] leading-[1.5] mb-2" style={{ color: colors.textSecondary }}>
            {askData.question}
          </p>

          {hasOptions ? (
            /* Option buttons — single tap answers the question */
            <div className="flex gap-1.5 flex-wrap">
              {askData.options.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => onAnswer(opt.label)}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                  style={{
                    background: colors.infoBg,
                    color: colors.infoText,
                    border: `1px solid ${colors.infoBorder}`,
                  }}
                  title={opt.description || undefined}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = colors.infoHoverBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = colors.infoBg
                  }}
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={onDismiss}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceActive
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
              >
                Dismiss
              </button>
            </div>
          ) : (
            /* Free-text input for open-ended questions */
            <div className="flex gap-1.5 items-center">
              <input
                type="text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="Type your answer..."
                autoFocus
                className="flex-1 text-[11px] px-2.5 py-1.5 rounded-lg outline-none"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textPrimary,
                  border: `1px solid ${colors.infoBorder}`,
                }}
              />
              <button
                onClick={handleSubmit}
                disabled={!freeText.trim()}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
                style={{
                  background: colors.infoBg,
                  color: colors.infoText,
                  border: `1px solid ${colors.infoBorder}`,
                }}
                onMouseEnter={(e) => {
                  if (freeText.trim()) e.currentTarget.style.background = colors.infoHoverBg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.infoBg
                }}
              >
                Send
              </button>
              <button
                onClick={onDismiss}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceActive
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
