import React from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import type { Message } from '../../../shared/types'
import { isClearDivider } from '../../../shared/clear-divider'

interface SystemMessageProps {
  message: Message
  skipMotion?: boolean
}

export function SystemMessage({ message, skipMotion }: SystemMessageProps) {
  const content = message.content || ''
  const isError = content.startsWith('Error:') || content.includes('unexpectedly')
  const isDivider = isClearDivider(content)
  const colors = useColors()

  // /clear checkpoint divider: render as a full-width horizontal rule with
  // centered label, distinct from the normal system-message bubble. Signals
  // a structural break in the conversation (LLM context reset) rather than
  // a chat turn or status message.
  if (isDivider) {
    const inner = (
      <div
        className="flex items-center w-full text-[11px] select-none"
        style={{ color: colors.textTertiary, userSelect: 'text' }}
        aria-label="Conversation cleared checkpoint"
      >
        <div className="flex-1 h-px" style={{ background: colors.textTertiary, opacity: 0.4 }} />
        <span className="px-2 whitespace-nowrap">{content}</span>
        <div className="flex-1 h-px" style={{ background: colors.textTertiary, opacity: 0.4 }} />
      </div>
    )
    if (skipMotion) return <div className="py-2">{inner}</div>
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="py-2"
      >
        {inner}
      </motion.div>
    )
  }

  const inner = (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
      <div
        className="text-[11px] leading-[1.5] px-2.5 py-1 rounded-lg inline-block whitespace-pre-wrap"
        style={{
          background: isError ? colors.statusErrorBg : colors.surfaceHover,
          color: isError ? colors.statusError : colors.textTertiary,
          userSelect: 'text',
        }}
      >
        {content}
      </div>
      {isError && <CopyButton text={content} />}
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
}
