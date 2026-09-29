/**
 * studio-window-bounds — persisted geometry for the Ion Studio window.
 *
 * Split out of studio-window-manager.ts to stay under the file-size cap.
 * Debounces resize/move persistence and flushes immediately before a
 * shortcut minimizes or a mode switch closes the window.
 */
import type { BrowserWindow } from "electron";
import { readSettings, writeSettings } from "@ion/server/persistence/settings-store";
import { log as _log, error as _error } from "./logger";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("studio", msg, fields);
}

export const STUDIO_DEFAULT_WIDTH = 960;
export const STUDIO_DEFAULT_HEIGHT = 640;

interface StudioWindowState {
  bounds: Electron.Rectangle;
  maximized: boolean;
}

/** Persisted window geometry and maximized state ({} when never saved). */
export function savedStudioBounds(): { bounds: Partial<Electron.Rectangle>; maximized: boolean } {
  try {
    const b = readSettings().studioBounds;
    if (b && typeof b === "object") {
      const candidate = b as Partial<StudioWindowState>;
      const rawBounds = candidate.bounds && typeof candidate.bounds === "object"
        ? candidate.bounds
        : b as Partial<Electron.Rectangle>;
      const bounds = rawBounds as Partial<Electron.Rectangle>;
      if (Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
        return {
          bounds: bounds as Electron.Rectangle,
          maximized: candidate.maximized === true,
        };
      }
    }
  } catch {
    // Unreadable settings: defaults below.
  }
  return { bounds: {}, maximized: false };
}

/** Window this window's pending-persist timer belongs to, per-window. */
export const maximizeOnReveal = new WeakMap<BrowserWindow, boolean>();

let boundsTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist current native window geometry without changing native window state. */
function writeStudioBounds(win: BrowserWindow, reason: string): boolean {
  if (win.isDestroyed()) return false;
  if (win.isMinimized()) {
    log("studio_window: bounds persistence skipped for minimized window", { reason });
    return false;
  }
  try {
    const settings = readSettings();
    const bounds = win.getNormalBounds();
    const maximized = win.isMaximized();
    settings.studioBounds = { bounds, maximized };
    writeSettings(settings);
    log("studio_window: bounds persisted", {
      reason,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    });
    return true;
  } catch (err) {
    _error("studio", "studio_window: bounds persist failed", {
      reason,
      error: String(err),
    });
    return false;
  }
}

/** Debounce normal resize/move persistence without ever storing minimized state. */
export function persistStudioBounds(win: BrowserWindow, reason = "geometry changed"): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    writeStudioBounds(win, reason);
  }, 400);
}

/** Make pending bounds durable before a shortcut minimizes or mode switch closes Studio. */
export function flushStudioBounds(win: BrowserWindow, reason: string): void {
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }
  writeStudioBounds(win, reason);
}
