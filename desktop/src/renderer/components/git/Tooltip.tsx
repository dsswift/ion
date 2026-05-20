import React, { useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../PopoverLayer'
import { useColors } from '../../theme'

interface Props {
  text: string
  children: React.ReactNode
  position?: 'above' | 'below'
}

export function Tooltip({ text, children, position = 'above' }: Props) {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const spanRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const onMouseEnter = useCallback(() => {
    timerRef.current = setTimeout(() => {
      const r = spanRef.current?.getBoundingClientRect()
      if (r) setRect(r)
    }, 400)
  }, [])

  const onMouseLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setRect(null)
  }, [])

  const posStyle: React.CSSProperties = rect
    ? position === 'below'
      ? { top: rect.bottom + 4, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' }
      : { bottom: window.innerHeight - rect.top + 4, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' }
    : {}

  return (
    <>
      <span
        ref={spanRef}
        style={{ display: 'inline-flex' }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        title={popoverLayer ? undefined : text}
      >
        {children}
      </span>
      {popoverLayer && rect && createPortal(
        <div style={{
          position: 'fixed',
          pointerEvents: 'none',
          ...posStyle,
          background: colors.popoverBg,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: `1px solid ${colors.popoverBorder}`,
          borderRadius: 6,
          padding: '3px 8px',
          fontSize: 10,
          color: colors.textSecondary,
          whiteSpace: 'nowrap',
          boxShadow: colors.popoverShadow,
        }}>
          {text}
        </div>,
        popoverLayer,
      )}
    </>
  )
}
