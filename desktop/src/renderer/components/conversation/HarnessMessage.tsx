import React from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../../theme'
import type { Message } from '../../../shared/types'

interface HarnessMessageProps {
  message: Message
  skipMotion?: boolean
  bootstrapCollapsedCount?: number
}

export function HarnessMessage({ message, skipMotion, bootstrapCollapsedCount }: HarnessMessageProps) {
  const colors = useColors()
  const showBadge = bootstrapCollapsedCount !== undefined && bootstrapCollapsedCount > 0

  const inner = (
    <div
      className="text-[11px] leading-[1.5] px-2.5 py-1 rounded-lg inline-flex items-baseline gap-1.5 whitespace-pre-wrap"
      style={{
        background: colors.surfaceHover,
        color: colors.textSecondary,
        borderLeft: `2px solid ${colors.accent}`,
      }}
    >
      {showBadge && (
        <span
          className="shrink-0 text-[10px] font-semibold px-1 py-0.5 rounded-full leading-none"
          style={{
            background: colors.surfaceHover,
            color: colors.textSecondary,
            outline: `1px solid ${colors.containerBorder}`,
          }}
        >
          ×{bootstrapCollapsedCount! + 1}
        </span>
      )}
      {message.content || ''}
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

