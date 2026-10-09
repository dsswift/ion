/**
 * studio-window-manager — lifecycle for the Ion Studio window.
 *
 * A single standard (framed, resizable) BrowserWindow, separate from the
 * frameless main overlay. Never more than one: opening focuses the existing
 * window. The window loads the second renderer entry (studio.html) with the same
 * preload surface as the main renderer; its engine-event stream arrives as
 * studio_event frames from the Studio server over `ipc/studio-bridge.ts`.
 *
 * The Studio is a standalone window, fully decoupled from the overlay's
 * show/hide lifecycle: open means open until the user closes it, regardless
 * of what Alt+Space does to the overlay.
 *
 * Pin semantics:
 *   - pinned: visible on all workspaces, alwaysOnTop at the 'floating' level
 *     (deliberately BELOW the main overlay's 'modal-panel' — see the TCC
 *     warning in window-manager.ts), floating over other NORMAL windows.
 *   - unpinned: a plain normal window (one Space, normal stacking).
 */
import { app, BrowserWindow } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { IPC } from "@ion/shared/types";
import {
  log as _log,
  debug as _debug,
  warn as _warn,
  error as _error,
  trace as _trace,
} from "./logger";
import { state } from "./state";
import {
  STUDIO_DEFAULT_WIDTH,
  STUDIO_DEFAULT_HEIGHT,
  savedStudioBounds,
  persistStudioBounds,
  flushStudioBounds,
  maximizeOnReveal,
} from "./studio-window-bounds";
import { clearBeacon } from "./studio-beacon";
import {
  attemptRendererRecovery,
  resetRendererCrashGuard,
} from "./renderer-crash-guard";
import { destroyAllBrowserViews, reapplyBrowserViewBounds } from "./studio-browser-views";
import { setStudioBrowserWindowResolver } from "./ipc/studio-browser";
import {
  STUDIO_TITLE_BAR_HEIGHT,
  STUDIO_TRAFFIC_LIGHT_POSITION,
} from "@ion/shared/studio-chrome";
import { launchTrace, startMainSpan } from "./spans";
import { LAUNCH_TRACEPARENT_ARG } from "../shared/desktop-ipc";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("studio", msg, fields);
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug("studio", msg, fields);
}

setStudioBrowserWindowResolver(() => state.studioWindow);

/**
 * Resolves the Studio window's icon path for the current platform (.ico on
 * win32, .icns elsewhere). Returns undefined (letting Electron fall back to
 * its default icon) when the platform-appropriate file is missing from the
 * packaged resources, logging why rather than silently shipping no icon.
 */
function resolveWindowIcon(): string | undefined {
  const iconPath = join(__dirname, "../../resources", process.platform === "win32" ? "icon.ico" : "icon.icns");
  if (!existsSync(iconPath)) {
    _warn("studio", "window icon missing", { path: iconPath, platform: process.platform });
    return undefined;
  }
  return iconPath;
}

/**
 * The Studio window is a NORMAL desktop window (single-UI exclusivity).
 *
 * The pin/always-on-top/level machinery that lived here was a relic of the
 * companion-window era, when the visualizer floated beside the overlay and
 * had to negotiate z-order with it ('floating' at rest, 'modal-panel' on
 * focus, visible-on-all-workspaces when pinned). Under exclusivity the
 * Studio window IS the application window: it participates in ordinary
 * macOS window ordering, Mission Control, and Spaces like any app, and
 * never calls setAlwaysOnTop. The studioPinned setting was removed with it
 * (boot migration drops the key).
 */

/**
 * Dock/Cmd-Tab presence: always 'regular' (Dock icon, Cmd-Tab entry) on
 * macOS. The accessory/regular toggle this used to perform existed only to
 * keep the deleted Overlay glass usable as a hotkey surface — hiding the
 * Dock icon while Studio was closed kept the transparent glass from
 * cluttering Cmd-Tab. Studio is a normal window now, with no accessory
 * surface to protect, so there is nothing left to toggle. No-op off macOS.
 * `studioOpen` is accepted for call-site compatibility but no longer
 * changes the outcome.
 */
export function applyStudioActivationPolicy(studioOpen: boolean): void {
  if (process.platform !== "darwin") {
    debug("studio_window: activation policy skipped", { platform: process.platform });
    return;
  }
  try {
    app.setActivationPolicy("regular");
    log("studio_window: activation policy", { policy: "regular", studio_open: studioOpen });
  } catch (err) {
    _error("studio", "studio_window: activation policy failed", {
      error: String(err),
    });
  }
}

export function setStudioTitleBarOverlay(
  color: string,
  symbolColor: string,
): boolean {
  const win = state.studioWindow;
  if (process.platform === "darwin" || !win || win.isDestroyed()) return false;
  try {
    win.setTitleBarOverlay({
      color,
      symbolColor,
      height: STUDIO_TITLE_BAR_HEIGHT,
    });
    log("studio_window: title bar overlay updated", { color, symbol_color: symbolColor });
    return true;
  } catch (err) {
    _error("studio", "studio_window: title bar overlay update failed", {
      color,
      symbol_color: symbolColor,
      error: String(err),
    });
    return false;
  }
}

/** True when a live Studio window exists (used by the app 'activate' router). */
export function isStudioWindowOpen(): boolean {
  return state.studioWindow != null && !state.studioWindow.isDestroyed();
}

/**
 * Re-assert the activation policy for the CURRENT Studio open state.
 *
 * Electron's setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})
 * flips the app to the 'accessory' activation policy as a side effect
 * (over-fullscreen visibility requires a UIElement app on macOS), silently
 * knocking Ion out of the Dock and Cmd-Tab and sending the Studio window
 * behind the previous app. Every call site of
 * setVisibleOnAllWorkspaces(..., {visibleOnFullScreen: true}) must call this
 * afterwards to restore 'regular' (spec 17: Studio always runs with a Dock
 * icon now — there is no longer an Overlay glass to trade off against).
 */
export function reassertStudioActivationPolicy(): void {
  applyStudioActivationPolicy(isStudioWindowOpen());
}



/** Surface the existing Studio window (dock click / Cmd-Tab activate). */
export function focusStudioWindow(source: string): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  // Activate the APP, not just the window. An accessory→regular policy flip
  // only fully registers with the Cmd-Tab switcher / Stage Manager once the
  // app actually activates; without this, switching to the Studio window bounces —
  // macOS refuses the activation and re-activates the previous app until
  // the user clicks the Dock icon.
  app.focus({ steal: true });
  const wasMinimized = win.isMinimized();
  if (wasMinimized) {
    win.restore();
  } else if (!win.isVisible()) {
    // Legacy/external hide state: surface without changing any saved geometry.
    win.show();
  }
  win.focus();
  log(wasMinimized ? "studio_window: restored and focused" : "studio_window: focused", { source });
}

/**
 * Show the Studio window that loaded behind the startup splash. `activate` is
 * whether Ion still held focus when startup finished: a user who switched to
 * another app while Ion loaded gets the window in the splash's place, behind
 * the app they are using, rather than pulled back to Ion.
 */
export function revealStudioWindow(source: string, activate: boolean): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  applyStudioActivationPolicy(true);
  if (activate) {
    app.focus({ steal: true });
    win.show();
  } else {
    win.showInactive();
  }
  if (maximizeOnReveal.get(win)) {
    maximizeOnReveal.delete(win);
    win.maximize();
  }
  if (activate) win.focus();
  log("studio_window: revealed", { source, activated: activate });
}

/**
 * Toggle Studio from its global shortcut. Unlike overlay mode, Studio is a
 * normal desktop window: focused → minimize; minimized → restore. Hiding is
 * reserved for legacy/external lifecycle paths and never changes shortcut
 * semantics or native bounds.
 */
export function toggleStudioWindow(source: string): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) {
    openStudioWindow(source);
    return;
  }
  if (win.isMinimized()) {
    focusStudioWindow(source);
    return;
  }
  if (win.isVisible() && win.isFocused()) {
    // Electron's resize sequence during minimize must not overwrite normal
    // bounds or maximized state. Capture them synchronously first.
    const maximized = win.isMaximized();
    flushStudioBounds(win, "before shortcut minimize");
    win.minimize();
    log("studio_window: minimized by toggle", { source, maximized });
    return;
  }
  focusStudioWindow(source);
}

/**
 * Open the Studio window, or focus it if it already exists. Idempotent;
 * there is never more than one Studio window. Studio is the only
 * conversation UI now, so this never refuses on a surface-plan check —
 * only "does the window already exist" gates the create-vs-focus branch.
 */
export function openStudioWindow(source = "unknown", reveal = true): void {
  if (state.studioWindow && !state.studioWindow.isDestroyed()) {
    if (!reveal) return
    if (state.studioWindow.webContents.isCrashed?.()) {
      // Crashes don't destroy windows; a manual open must never focus the
      // dead shell. Reload regardless of the automatic budget's state.
      log("studio_window: reloading crashed renderer on manual open", {
        source,
      });
      resetRendererCrashGuard("studio");
      state.studioWindow.webContents.reload();
    }
    focusStudioWindow(`open existing (${source})`);
    return;
  }

  log("studio_window: creating", { source });
  const saved = savedStudioBounds();
  // `window.ready`: creation → ready-to-show, a child of `app.launch`. The
  // renderer gets the launch traceparent as an argument so its own boot
  // spans join the same trace.
  const launch = launchTrace();
  const readySpan = startMainSpan("window.ready", { parent: launch.traceparent, attributes: { window: "studio", source } });
  const win = new BrowserWindow({
    width: saved.bounds.width ?? STUDIO_DEFAULT_WIDTH,
    height: saved.bounds.height ?? STUDIO_DEFAULT_HEIGHT,
    minWidth: 520,
    minHeight: 420,
    ...(saved.bounds.x != null && saved.bounds.y != null ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: STUDIO_TRAFFIC_LIGHT_POSITION,
        }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { height: STUDIO_TITLE_BAR_HEIGHT },
        }),
    title: "Ion",
    show: false,
    backgroundColor: "#14161c",
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: [`${LAUNCH_TRACEPARENT_ARG}${launch.traceparent}`],
    },
  });
  state.studioWindow = win;

  // Renderer console output, tagged so it is distinguishable in desktop.jsonl.
  //
  // Electron's levels are 0 verbose, 1 info, 2 warning, 3 error. The two
  // lowest used to be mapped the wrong way round -- verbose to DEBUG and info
  // to TRACE -- so the more important of the two was recorded at the lower
  // level, and at the default level (DEBUG) a stray console.log or
  // console.info from third-party code in the renderer was dropped while
  // console.debug was kept.
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) {
      _error("studio-renderer", message);
    } else if (level === 2) {
      _warn("studio-renderer", message);
    } else if (level === 1) {
      _debug("studio-renderer", message);
    } else {
      _trace("studio-renderer", message);
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    _error("studio", "studio_window: renderer gone", {
      reason: details.reason,
      exit_code: details.exitCode,
    });
    if (details.reason === "clean-exit") return;
    attemptRendererRecovery("studio", details, () => {
      // The Studio runs the session store in mirror mode (ADR-021): a fresh
      // renderer re-hydrates from main's caches and broadcasts on boot, so a
      // reload (or recreate) restores it without renderer-side state.
      if (state.studioWindow && !state.studioWindow.isDestroyed()) {
        state.studioWindow.webContents.reload();
      } else {
        openStudioWindow("crash-recovery");
      }
    });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    _error("studio", "studio_window: load failed", { code, description, url });
  });

  win.once("ready-to-show", () => {
    readySpan.end({ revealed: reveal, current: state.studioWindow === win });
    if (state.studioWindow === win && !win.isDestroyed()) {
      if (!reveal) {
        maximizeOnReveal.set(win, saved.maximized);
        log("studio_window: ready behind startup splash");
        return;
      }
      win.show();
      if (saved.maximized) win.maximize();
      applyStudioActivationPolicy(true);
      // Complete the accessory→regular transition (see focusStudioWindow) so
      // Ion appears in Cmd-Tab immediately, not after a Dock click.
      app.focus({ steal: true });
      win.focus();
      log("studio_window: shown");
    }
  });

  win.on("resize", () => persistStudioBounds(win, "resize"));
  win.on("enter-full-screen", () => {
    win.webContents.send(IPC.STUDIO_WINDOW_CHROME, { fullScreen: true });
    log("studio_window: entered full screen");
  });
  win.on("leave-full-screen", () => {
    win.webContents.send(IPC.STUDIO_WINDOW_CHROME, { fullScreen: false });
    log("studio_window: left full screen");
  });
  win.on("move", () => persistStudioBounds(win, "move"));
  win.on("maximize", () => persistStudioBounds(win, "maximize"));
  win.on("unmaximize", () => persistStudioBounds(win, "unmaximize"));
  win.on("focus", () => clearBeacon());
  // `closed` is too late to inspect bounds. Flush while the native window is
  // live so Studio → Overlay switching preserves latest windowed/maximized state.
  win.on("close", () => flushStudioBounds(win, "before close"));

  // A view is positioned in window coordinates and does not reflow with the
  // page, so a window resize has to re-apply the last bounds the renderer
  // measured or the browser body detaches from its hole.
  win.on("resize", () => reapplyBrowserViewBounds(win));

  win.on("closed", () => {
    // Browser views are children of this window; releasing them here keeps a
    // closed Studio from leaving orphaned guests holding sessions open.
    destroyAllBrowserViews();
    if (state.studioWindow === win) {
      state.studioWindow = null;
    }
    applyStudioActivationPolicy(false);
    log("studio_window: closed");
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = `${process.env.ELECTRON_RENDERER_URL}/studio.html`;
    log("studio_window: loading dev url", { url });
    void win.loadURL(url);
  } else {
    const file = join(__dirname, "../renderer/studio.html");
    log("studio_window: loading file", { file });
    void win.loadFile(file);
  }
}

