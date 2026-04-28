import React from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../../theme'
import type { Message } from '../../../shared/types'

interface HarnessMessageProps {
  message: Message
  skipMotion?: boolean
}

export function HarnessMessage({ message, skipMotion }: HarnessMessageProps) {
  const colors = useColors()

  const inner = (
    <div
      className="text-[11px] leading-[1.5] px-2.5 py-1 rounded-lg inline-block whitespace-pre-wrap"
      style={{
        background: colors.surfaceHover,
        color: colors.textSecondary,
        borderLeft: `2px solid ${colors.accent}`,
      }}
    >
      {message.content}
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
