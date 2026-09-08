/**
 * Shared Studio window chrome geometry.
 *
 * Main positions macOS traffic lights with these coordinates. Renderer reserves
 * matching space before interactive controls. Keeping both values here prevents
 * a native control from overlapping renderer chrome after a future adjustment.
 *
 * On Windows the 140px right inset (WINDOW_CONTROL_OVERLAY_INSET) reserves
 * the Window Controls Overlay (minimize, maximize, close) drawn by
 * `titleBarOverlay`. It is a fixed estimate; measuring
 * `windowControlsOverlay.getTitlebarAreaRect()` at runtime is the future
 * replacement once a Studio-Windows visual pass revisits this geometry.
 */
export const STUDIO_TITLE_BAR_HEIGHT = 38;

export const STUDIO_TRAFFIC_LIGHT_POSITION = { x: 12, y: 13 } as const;

const MACOS_TRAFFIC_LIGHT_INSET = 78;
const WINDOW_CONTROL_OVERLAY_INSET = 140;

export interface StudioWindowControlInset {
  left: number;
  right: number;
}

export function studioWindowControlInset(
  platform: NodeJS.Platform,
): StudioWindowControlInset {
  if (platform === "darwin") {
    return { left: MACOS_TRAFFIC_LIGHT_INSET, right: 0 };
  }
  return { left: 0, right: WINDOW_CONTROL_OVERLAY_INSET };
}
