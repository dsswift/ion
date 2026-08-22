/**
 * Shared Studio window chrome geometry.
 *
 * Main positions macOS traffic lights with these coordinates. Renderer reserves
 * matching space before interactive controls. Keeping both values here prevents
 * a native control from overlapping renderer chrome after a future adjustment.
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
