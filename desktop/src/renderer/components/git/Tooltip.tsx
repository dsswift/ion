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
}

export function Tooltip({ text, children, position = 'above' }: Props) {
  return (
    <HoverCard content={text} fallbackTitle={text} position={position}>
      {children}
    </HoverCard>
  )
}
