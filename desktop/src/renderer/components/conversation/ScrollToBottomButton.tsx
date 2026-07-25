import React from 'react'
import { ArrowDown } from '@phosphor-icons/react'
import { useColors } from '../../theme'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
}

export function ScrollToBottomButton({ visible, onClick }: ScrollToBottomButtonProps) {
  const colors = useColors()
  if (!visible) return null
  return (
    <button
      onClick={onClick}
      style={{
        position: 'absolute',
        bottom: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 3,
        width: 28,
        height: 28,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.popoverBg,
        border: `1px solid ${colors.containerBorder}`,
        color: colors.textSecondary,
        cursor: 'pointer',
        boxShadow: colors.cardShadow,
      }}
      title="Scroll to bottom"
    >
      <ArrowDown size={14} />
    </button>
  )
}
