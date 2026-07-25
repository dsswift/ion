import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUp } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'

export interface SendButtonProps {
  visible: boolean
  isBusy: boolean
  /** Renders the button dimmed and inert (no hover/pressed, click ignored). */
  disabled?: boolean
  colors: ReturnType<typeof useColors>
  onClick: () => void
}

/**
 * Animated send button. Wrapped in AnimatePresence so callers only
 * need to flip `visible` to fade it in/out.
 *
 * Interactive states follow the desktop style guide: hover → `sendHover`,
 * pressed → `accentPressed` + 0.97 scale, disabled → `sendDisabled` at 0.45
 * opacity with inert handlers. Keyboard focus rides `.ion-focusable`.
 */
export function SendButton({ visible, isBusy, disabled = false, colors, onClick }: SendButtonProps) {
  const { hover, pressed, handlers } = useInteractiveState()
  const interactive = !disabled

  const background = disabled
    ? colors.sendDisabled
    : pressed
      ? colors.accentPressed
      : hover
        ? colors.sendHover
        : colors.sendBg

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
            disabled={disabled}
            // preventDefault keeps the textarea focused when the button is
            // clicked; the pressed state still tracks via the hook.
            onMouseDown={(e) => {
              e.preventDefault()
              if (interactive) handlers.onMouseDown()
            }}
            onMouseUp={interactive ? handlers.onMouseUp : undefined}
            onMouseEnter={interactive ? handlers.onMouseEnter : undefined}
            onMouseLeave={handlers.onMouseLeave}
            onBlur={handlers.onBlur}
            onClick={interactive ? onClick : undefined}
            className="ion-focusable w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background,
              color: colors.textOnAccent,
              opacity: disabled ? 0.45 : 1,
              cursor: disabled ? 'default' : 'pointer',
              transform: pressed && interactive ? 'scale(0.97)' : 'scale(1)',
              // Inline transition replaces the .ion-focusable class shorthand,
              // so it must re-list box-shadow for the focus ring to animate.
              transition: `background ${transitions.base}, box-shadow ${transitions.base}, transform ${transitions.fast}`,
            }}
            title={isBusy ? 'Queue message' : 'Send (Enter)'}
          >
            <ArrowUp size={16} weight="bold" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
