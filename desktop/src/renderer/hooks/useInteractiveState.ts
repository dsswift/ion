import { useMemo, useState } from 'react'
import type { ColorPalette } from '../theme-tokens'

/**
 * Pointer-state tracking for inline-styled interactive elements.
 *
 * Ion styles components with inline styles from `useColors()`, which CSS
 * `:hover` / `:active` pseudo-classes cannot drive. This hook is the standard
 * seam for those states: spread `handlers` onto the element and pick token
 * values from `hover` / `pressed`. Keyboard focus stays in CSS — put the
 * `.ion-focusable` class (index.css) on the element for the focus-visible
 * ring; the two compose.
 *
 * `pressed` resets on mouse-leave and blur so a drag-off-and-release never
 * strands the pressed style.
 */
export interface InteractiveHandlers {
  onMouseEnter: () => void
  onMouseLeave: () => void
  onMouseDown: () => void
  onMouseUp: () => void
  onBlur: () => void
}

export interface InteractiveState {
  hover: boolean
  pressed: boolean
  handlers: InteractiveHandlers
}

export function useInteractiveState(): InteractiveState {
  const [hover, setHover] = useState(false)
  const [pressed, setPressed] = useState(false)

  const handlers = useMemo<InteractiveHandlers>(
    () => ({
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => {
        setHover(false)
        setPressed(false)
      },
      onMouseDown: () => setPressed(true),
      onMouseUp: () => setPressed(false),
      onBlur: () => setPressed(false),
    }),
    [],
  )

  return { hover, pressed, handlers }
}

type InteractiveBgTokens = Pick<ColorPalette, 'surfaceHover' | 'surfacePressed' | 'surfaceSelected'>

/**
 * Standard background cascade for interactive rows/buttons:
 * pressed > hover > selected > base. Selected surfaces additionally set
 * `fontWeight: 500` at the call site (see the desktop style guide).
 */
export function interactiveBg(
  colors: InteractiveBgTokens,
  state: { hover?: boolean; pressed?: boolean; selected?: boolean },
  base = 'transparent',
): string {
  if (state.pressed) return colors.surfacePressed
  if (state.hover) return colors.surfaceHover
  if (state.selected) return colors.surfaceSelected
  return base
}
