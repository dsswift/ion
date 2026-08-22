export interface OverlayBodyHeights {
  terminal: number
  conversation: number
}

const OVERLAY_VERTICAL_CHROME = 60
const MIN_BODY_HEIGHT = 96
const MAX_BODY_HEIGHT = 420

/**
 * Fit normal overlay bodies inside the CSS viewport. Root UI zoom reduces the
 * available CSS height, so fixed 420px terminal and conversation bodies cannot
 * both remain pinned inside a small physical window.
 */
export function resolveOverlayBodyHeights(
  viewportHeight: number,
  inputRowHeight: number,
  terminalOpen: boolean,
): OverlayBodyHeights {
  const available = Math.max(MIN_BODY_HEIGHT, viewportHeight - inputRowHeight - OVERLAY_VERTICAL_CHROME)
  if (!terminalOpen) {
    return { terminal: 0, conversation: Math.max(MIN_BODY_HEIGHT, Math.min(MAX_BODY_HEIGHT, available)) }
  }

  const split = Math.max(MIN_BODY_HEIGHT, Math.min(MAX_BODY_HEIGHT, Math.floor((available - 10) / 2)))
  return {
    terminal: split,
    conversation: Math.max(MIN_BODY_HEIGHT, available - split - 10),
  }
}
