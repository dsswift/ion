import React from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import type { Message } from '../../../shared/types'

interface SystemMessageProps {
  message: Message
  skipMotion?: boolean
}

export function SystemMessage({ message, skipMotion }: SystemMessageProps) {
  const isError = message.content.startsWith('Error:') || message.content.includes('unexpectedly')
  const colors = useColors()

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
        {message.content}
      </div>
      {isError && <CopyButton text={message.content} />}
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
