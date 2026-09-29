export type ResponsiveMode = 'wide' | 'medium' | 'compressed'

export interface StudioResponsiveLayout {
  mode: ResponsiveMode
  leftWidth: number
  surfaceWidth: number
}

const STUDIO_CENTER_FLOOR = 360
const STUDIO_LEFT_MIN = 260
const STUDIO_SURFACE_MIN = 320

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Resolve the width of every pane the operator has asked to see. Every
 * requested pane always gets a width: this function never answers "show one
 * pane instead of three".
 *
 * That used to be a `narrow` mode which returned the full viewport width for
 * both side panes and left StudioShell to render one primary pane at a time.
 * It made a small window behave unlike the desktop it mirrors — opening
 * either sidebar swallowed the conversation entirely, and the only way back
 * was to widen the window and re-hide the sidebar. The desktop never drops a
 * pane on resize; it resizes them. So below the point where all three fit at
 * their minimums, `compressed` mode scales all three by the SAME factor
 * rather than choosing between them.
 */
export function resolveStudioResponsiveLayout(input: {
  width: number
  leftRequested: boolean
  surfaceRequested: boolean
  preferredLeftWidth: number
  preferredSurfaceWidth: number
}): StudioResponsiveLayout {
  const width = Math.max(0, input.width)
  const minimumTotal = STUDIO_CENTER_FLOOR
    + (input.leftRequested ? STUDIO_LEFT_MIN : 0)
    + (input.surfaceRequested ? STUDIO_SURFACE_MIN : 0)

  if (width < minimumTotal) {
    // Proportional squeeze. Scaling every pane by one factor keeps their
    // relative proportions recognizable and, crucially, keeps all three on
    // screen: a center column of a few hundred pixels is still a usable
    // conversation, whereas a hidden one is not.
    const scale = minimumTotal > 0 ? width / minimumTotal : 0
    return {
      mode: 'compressed',
      leftWidth: input.leftRequested ? Math.floor(STUDIO_LEFT_MIN * scale) : 0,
      surfaceWidth: input.surfaceRequested ? Math.floor(STUDIO_SURFACE_MIN * scale) : 0,
    }
  }

  const preferredTotal = STUDIO_CENTER_FLOOR
    + (input.leftRequested ? input.preferredLeftWidth : 0)
    + (input.surfaceRequested ? input.preferredSurfaceWidth : 0)
  if (width >= preferredTotal) {
    return {
      mode: 'wide',
      leftWidth: input.leftRequested ? input.preferredLeftWidth : 0,
      surfaceWidth: input.surfaceRequested ? input.preferredSurfaceWidth : 0,
    }
  }

  const remaining = Math.max(0, width - STUDIO_CENTER_FLOOR)
  let leftWidth = 0
  let surfaceWidth = 0
  if (input.leftRequested && input.surfaceRequested) {
    const preferredSides = input.preferredLeftWidth + input.preferredSurfaceWidth
    leftWidth = clamp(remaining * input.preferredLeftWidth / preferredSides, STUDIO_LEFT_MIN, remaining - STUDIO_SURFACE_MIN)
    surfaceWidth = remaining - leftWidth
  } else if (input.leftRequested) {
    leftWidth = clamp(input.preferredLeftWidth, STUDIO_LEFT_MIN, remaining)
  } else if (input.surfaceRequested) {
    surfaceWidth = clamp(input.preferredSurfaceWidth, STUDIO_SURFACE_MIN, remaining)
  }
  return { mode: 'medium', leftWidth, surfaceWidth }
}


export function resolveResponsiveColumns(width: number, breakpoint: number): 1 | 2 {
  return width >= breakpoint ? 2 : 1
}
