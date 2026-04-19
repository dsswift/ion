import React from 'react'
import { motion } from 'framer-motion'
import { Square } from '@phosphor-icons/react'
import { useColors } from '../../theme'

interface InterruptButtonProps {
  onInterrupt: () => void
}

export function InterruptButton({ onInterrupt }: InterruptButtonProps) {
  const colors = useColors()

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={onInterrupt}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0 transition-colors"
      style={{
        background: 'transparent',
        color: colors.statusError,
        border: 'none',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = colors.statusErrorBg }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      title="Stop current task"
    >
      <Square size={9} weight="fill" />
      <span>Interrupt</span>
    </motion.button>
  )
}
