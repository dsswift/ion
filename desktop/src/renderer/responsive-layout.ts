export type ResponsiveMode = 'wide' | 'medium' | 'narrow'

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
 * Resolve only the widths that can be shown together. Narrow mode deliberately
 * leaves pane selection to StudioShell, which renders one primary pane at a time.
 */
export function resolveStudioResponsiveLayout(input: {
  width: number
  leftRequested: boolean
  surfaceRequested: boolean
  preferredLeftWidth: number
  preferredSurfaceWidth: number
}): StudioResponsiveLayout {
  const width = Math.max(0, input.width)
  const requestedMinimum = STUDIO_CENTER_FLOOR
    + (input.leftRequested ? STUDIO_LEFT_MIN : 0)
    + (input.surfaceRequested ? STUDIO_SURFACE_MIN : 0)
  if (width < requestedMinimum) {
    return { mode: 'narrow', leftWidth: width, surfaceWidth: width }
  }

  const preferredTotal = STUDIO_CENTER_FLOOR
    + (input.leftRequested ? input.preferredLeftWidth : 0)
    + (input.surfaceRequested ? input.preferredSurfaceWidth : 0)
  if (width >= preferredTotal) {
    return {
      mode: 'wide',
      leftWidth: input.preferredLeftWidth,
      surfaceWidth: input.preferredSurfaceWidth,
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

export interface OverlayPanelPlacement {
  external: boolean
  width: number
}

/** Keep wide overlay rails outside the card; move them over the card when clipped. */
export function resolveOverlayPanelPlacement(
  viewportWidth: number,
  contentWidth: number,
  preferredWidth: number,
  gap: number,
): OverlayPanelPlacement {
  const safeViewport = Math.max(0, viewportWidth)
  const safeContent = Math.min(Math.max(0, contentWidth), safeViewport)
  const sideClearance = Math.max(0, (safeViewport - safeContent) / 2)
  return sideClearance >= preferredWidth + gap
    ? { external: true, width: preferredWidth }
    : { external: false, width: Math.min(preferredWidth, safeContent) }
}

export function resolveViewportContentWidth(preferredWidth: number, viewportWidth: number, gutter = 16): number {
  return Math.min(preferredWidth, Math.max(0, viewportWidth - gutter * 2))
}

export function resolveResponsiveColumns(width: number, breakpoint: number): 1 | 2 {
  return width >= breakpoint ? 2 : 1
}
