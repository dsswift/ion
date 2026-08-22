/** Worktree overlap visualizer window. */
import { BrowserWindow } from "electron";
import { join } from "path";
import { log as _log, error as _error } from "./logger";
import { state } from "./state";
import { applyStudioActivationPolicy } from "./studio-window-manager";
import type { WorktreeOverlapContext } from "../shared/types-worktree-overlap";

const TAG = "worktree.overlap.window";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}

let context: WorktreeOverlapContext | null = null;

export function openWorktreeOverlapWindow(next: WorktreeOverlapContext): void {
  context = next;
  const existing = state.worktreeOverlapWindow;
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    log("focused existing window", {
      repo_path: next.repoPath,
      source_branch: next.sourceBranch ?? "",
    });
    return;
  }
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: "Ion · Worktree Overlap",
    show: false,
    backgroundColor: "#14161c",
    icon: join(__dirname, "../../resources/icon.icns"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  state.worktreeOverlapWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    _error(TAG, "renderer process gone", {
      reason: details.reason,
      exit_code: details.exitCode,
    });
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    win.setAlwaysOnTop(true, "modal-panel");
    win.moveTop();
    applyStudioActivationPolicy(true);
  });
  win.on("focus", () => {
    win.setAlwaysOnTop(true, "modal-panel");
    win.moveTop();
    log("window raised above overlay");
  });
  win.on("blur", () => {
    // Keep overlap visible behind the overlay, not minimized or hidden. Normal
    // level yields the same active/inactive layering behavior as FileEditor.
    win.setAlwaysOnTop(false);
    log("window lowered behind overlay");
  });
  win.on("closed", () => {
    if (state.worktreeOverlapWindow === win) state.worktreeOverlapWindow = null;
    applyStudioActivationPolicy(false);
    log("window closed");
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win
      .loadURL(`${process.env.ELECTRON_RENDERER_URL}/worktree-overlap.html`)
      .catch((error) => {
        _error(TAG, "could not load development renderer", {
          error: String(error),
        });
      });
  } else {
    void win
      .loadFile(join(__dirname, "../renderer/worktree-overlap.html"))
      .catch((error) => {
        _error(TAG, "could not load packaged renderer", {
          error: String(error),
        });
      });
  }
  log("created window", {
    repo_path: next.repoPath,
    source_branch: next.sourceBranch ?? "",
  });
}

export function focusWorktreeOverlapWindow(source: string): void {
  const win = state.worktreeOverlapWindow;
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  log("focused window", { source });
}

export function preserveWorktreeOverlapWindow(): void {
  const win = state.worktreeOverlapWindow;
  if (!win || win.isDestroyed()) return;
  // Showing the full-screen overlay can cause macOS to minimize or hide a
  // normal sibling window. Restore it without focusing it: overlay remains the
  // foreground surface, while overlap stays available underneath rather than
  // disappearing from the operator's workspace.
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.showInactive();
  log("preserved window while overlay opened");
}

export function worktreeOverlapContext(
  senderId: number,
): WorktreeOverlapContext | null {
  const win = state.worktreeOverlapWindow;
  if (!win || win.isDestroyed() || win.webContents.id !== senderId) return null;
  return context;
}
