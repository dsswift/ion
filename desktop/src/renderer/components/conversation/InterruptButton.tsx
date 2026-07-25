import React from 'react'
import { motion } from 'framer-motion'
import { Square } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useInteractiveState } from '../../hooks/useInteractiveState'

interface InterruptButtonProps {
  onInterrupt: () => void
}

export function InterruptButton({ onInterrupt }: InterruptButtonProps) {
  const colors = useColors()
  // Danger-family cascade: hover → statusErrorBg tint, pressed → the deeper
  // permissionDenyHoverBg tint. Keyboard focus rides `.ion-focusable`, whose
  // class transition covers the background shift.
  const { hover, pressed, handlers } = useInteractiveState()

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={onInterrupt}
      {...handlers}
      className="ion-focusable inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0"
      style={{
        background: pressed
          ? colors.permissionDenyHoverBg
          : hover
            ? colors.statusErrorBg
            : 'transparent',
        color: colors.statusError,
        border: 'none',
      }}
      title="Stop current task"
    >
      <Square size={9} weight="fill" />
      <span>Interrupt</span>
    </motion.button>
  )
}
