import type { BrowserWindow, Tray } from "electron";
import { setStudioBrowserWindowResolver } from './studio-browser-window-resolver';

/**
 * Desktop-only process state: the Electron window and tray references this
 * process owns, and nothing else.
 *
 * Everything headless -- the engine bridge, the session plane, the session
 * store, the device transport, the caches the snapshot projection reads --
 * lives in the Ion Studio Server (`server/src/state.ts`), which runs as its
 * own process (ADR-033). This file used to re-export all of it so the
 * desktop's shell files kept compiling while they were rewired as a Studio
 * client; that rewiring is done, the desktop reaches the server only over
 * the Studio wire, and `scripts/check-server-parity.sh` (Check 7) refuses a
 * main-process import of the server's engine or store modules.
 */

export const DEBUG_MODE = process.env.Ion_DEBUG === "1";
export const SPACES_DEBUG = DEBUG_MODE || process.env.Ion_SPACES_DEBUG === "1";

export interface DesktopState {
  /** A quit is underway; the before-quit dialog must not interpose again. */
  forceQuit: boolean;
  tray: Tray | null;
  /** The Ion Studio window (single instance; null when closed). */
  studioWindow: BrowserWindow | null;
  /** Standalone startup card, visible until the selected product surface is ready. */
  splashWindow: BrowserWindow | null;
  /** The desktop-only Worktree Overlap visualizer window. */
  worktreeOverlapWindow: BrowserWindow | null;
  /** Monospace families enumerated from the OS once per process (`ipc/system.ts`). */
  cachedFonts: string[] | null;
  /** Per-process sequence numbers for screenshot and pasted-image attachment filenames (`ipc/attachments.ts`). */
  screenshotCounter: number;
}

export const state: DesktopState = {
  forceQuit: false,
  tray: null,
  studioWindow: null,
  splashWindow: null,
  worktreeOverlapWindow: null,
  cachedFonts: null,
  screenshotCounter: 0,
};

setStudioBrowserWindowResolver(() => state.studioWindow);
