/**
 * Tooltip — a single line of text on hover.
 *
 * A thin wrapper over `HoverCard`, which owns the hover mechanics (intent
 * delay, measurement, portalling past the Electron overlay, keyboard parity).
 * This component exists for the common case and to keep the dozens of existing
 * `<Tooltip text="...">` call sites unchanged.
 */
import React from 'react'
import { HoverCard } from './HoverCard'

interface Props {
  text: string
  children: React.ReactNode
  position?: 'above' | 'below'
  /**
   * Merged onto the wrapper span.
   *
   * The wrapper is the real flex/grid item wherever a tooltipped element sits
   * in a flex row — the caller's own element is only its child. So a caller
   * that sets `flexShrink: 1` + `overflow: hidden` on its text and expects an
   * ellipsis gets neither: the wrapper's automatic minimum size is the child's
   * full intrinsic width, and the row overflows instead. Passing
   * `{ minWidth: 0, flex: 1, overflow: 'hidden' }` here is what makes the
   * shrink actually reach the text.
   */
  style?: React.CSSProperties
}

export function Tooltip({ text, children, position = 'above', style }: Props) {
  return (
    <HoverCard content={text} fallbackTitle={text} position={position} style={style}>
      {children}
    </HoverCard>
  )
}
