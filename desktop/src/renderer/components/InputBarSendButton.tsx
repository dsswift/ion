import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUp } from '@phosphor-icons/react'
import { useColors } from '../theme'

export interface SendButtonProps {
  visible: boolean
  isBusy: boolean
  colors: ReturnType<typeof useColors>
  onClick: () => void
}

/**
 * Animated send button. Wrapped in AnimatePresence so callers only
 * need to flip `visible` to fade it in/out.
 */
export function SendButton({ visible, isBusy, colors, onClick }: SendButtonProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="send"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.1 }}
        >
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
            style={{ background: colors.sendBg, color: colors.textOnAccent }}
            title={isBusy ? 'Queue message' : 'Send (Enter)'}
          >
            <ArrowUp size={16} weight="bold" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
