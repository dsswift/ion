/**
 * studio-window-manager — lifecycle for the Ion Studio window.
 *
 * A single standard (framed, resizable) BrowserWindow, separate from the
 * frameless main overlay. Never more than one: opening focuses the existing
 * window. The window loads the second renderer entry (studio.html) with the same
 * preload surface as the main renderer, so it consumes the same
 * `ion:normalized-event` stream (filtered in broadcast.ts).
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
import type { StudioUserMessageEcho, StudioHistoryReplace } from "../shared/types-studio";
import { IPC } from "../shared/types";
import {
  log as _log,
  debug as _debug,
  warn as _warn,
  error as _error,
  trace as _trace,
} from "./logger";
import { state, enterprisePolicyCache } from "./state";
import { readSettings, writeSettings } from "./settings-store";
import { resolveSurfacePlan } from "./surface-launch";
import { getStudioState } from "./studio-state-cache";
import { clearBeacon } from "./studio-beacon";
import {
  markDeepLinkConfirmationReady,
  markDeepLinkConfirmationUnavailable,
} from "./deeplink/confirm";
import {
  attemptRendererRecovery,
  resetRendererCrashGuard,
} from "./renderer-crash-guard";
import { installWebviewPolicy } from "./webview-policy";
import {
  STUDIO_TITLE_BAR_HEIGHT,
  STUDIO_TRAFFIC_LIGHT_POSITION,
} from "../shared/studio-chrome";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("studio", msg, fields);
}

const STUDIO_DEFAULT_WIDTH = 960;
const STUDIO_DEFAULT_HEIGHT = 640;

interface StudioWindowState {
  bounds: Electron.Rectangle;
  maximized: boolean;
}

/** Persisted window geometry and maximized state ({} when never saved). */
function savedStudioBounds(): { bounds: Partial<Electron.Rectangle>; maximized: boolean } {
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

let boundsTimer: ReturnType<typeof setTimeout> | null = null;
const maximizeOnReveal = new WeakMap<BrowserWindow, boolean>();

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
function persistStudioBounds(win: BrowserWindow, reason = "geometry changed"): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    writeStudioBounds(win, reason);
  }, 400);
}

/** Make pending bounds durable before a shortcut minimizes or mode switch closes Studio. */
function flushStudioBounds(win: BrowserWindow, reason: string): void {
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }
  writeStudioBounds(win, reason);
}

/**
 * Persist whether the Studio window is open (one global flag, like studioBounds).
 * surface-launch reads it at startup so a Studio window left open at quit reopens —
 * unless the surface policy disabled the Studio window between restarts.
 */
function persistStudioOpenState(open: boolean): void {
  try {
    const settings = readSettings();
    settings.studioWindowOpen = open;
    writeSettings(settings);
    log("studio_window: open state persisted", { open });
  } catch (err) {
    _error("studio", "studio_window: open state persist failed", {
      error: String(err),
    });
  }
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
 * Re-arm the main overlay's mouse-event forwarding.
 *
 * The full-screen transparent overlay relies on setIgnoreMouseEvents(true,
 * {forward: true}): forwarded mousemoves drive the renderer's click-through
 * hook, which un-ignores over interactive UI. Creating or focusing a SECOND
 * window invalidates the macOS mouse-tracking area behind that forwarding —
 * the renderer stops receiving mousemoves, its ignore state goes stale, and
 * every click either passes through the overlay to background apps or gets
 * eaten by the invisible shell (the reported symptom; hiding and re-showing
 * the overlay "fixed" it because show recreates the tracking area). Forcing
 * ignore+forward from the main process on every Studio lifecycle transition
 * recreates the tracking area and resets the overlay to its safe state
 * (pass-through until the renderer sees the cursor over real UI again).
 */
function rearmOverlayClickThrough(reason: string): void {
  const main = state.mainWindow;
  if (!main || main.isDestroyed()) return;
  main.setIgnoreMouseEvents(true, { forward: true });
  log("studio_window: overlay click-through re-armed", { reason });
}

/**
 * Dock/Cmd-Tab presence: Ion runs as a macOS accessory app (no Dock icon) so
 * the overlay stays a hotkey surface. The Studio is a normal window the user
 * switches to like an app, so while it is open — and the studioDockPresence
 * setting allows it — the activation policy flips to 'regular' (Dock icon,
 * Cmd-Tab entry). Closing the Studio window reverts to accessory. No-op off macOS.
 */
export function applyStudioActivationPolicy(studioOpen: boolean): void {
  if (process.platform !== "darwin") return;
  let allowed = true;
  try {
    allowed = readSettings().studioDockPresence !== false;
  } catch {
    // Unreadable settings: keep the default (present).
  }
  const regular = studioOpen && allowed;
  try {
    app.setActivationPolicy(regular ? "regular" : "accessory");
    if (!regular && app.dock) app.dock.hide();
    log("studio_window: activation policy", {
      policy: regular ? "regular" : "accessory",
      studio_open: studioOpen,
      allowed,
    });
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
 * (over-fullscreen visibility requires a UIElement app on macOS). The
 * overlay runs that call on EVERY show, and the Studio window pin path runs it too —
 * each silently knocking Ion out of the Dock and Cmd-Tab while the Studio window is
 * open, sending the Studio window behind the previous app. Every call site of
 * setVisibleOnAllWorkspaces(..., {visibleOnFullScreen: true}) must call
 * this afterwards. Known trade-off: while the Studio window holds 'regular' policy,
 * the overlay cannot float over OTHER apps' fullscreen Spaces (macOS allows
 * one or the other, not both).
 */
export function reassertStudioActivationPolicy(): void {
  applyStudioActivationPolicy(isStudioWindowOpen());
}

/** Push Studio open/closed to the overlay renderer (launcher-button indicator). */
function notifyStudioWindowState(open: boolean): void {
  const main = state.mainWindow;
  if (!main || main.isDestroyed()) return;
  main.webContents.send(IPC.STUDIO_WINDOW_STATE, open);
}

/**
 * Push "this permission was answered (by any surface)" to the Studio window so
 * its mirror queue and canvas bubble clear instantly. Fired from the
 * respondToPermission choke point in the control plane.
 */
export function notifyStudioPermissionResolved(
  tabId: string,
  questionId: string,
): void {  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.STUDIO_PERMISSION_RESOLVED, tabId, questionId);
  log("studio_window: permission resolved pushed", {
    tab_id: tabId,
    question_id: questionId,
  });
}

/**
 * Push a submitted user prompt to the Studio mirror (any surface's prompt —
 * user turns never ride normalized events; the owner's optimistic insert
 * lives only in its own store). Fired from the IPC.PROMPT funnel.
 */
export function notifyStudioUserMessageEcho(
  tabId: string,
  echo: StudioUserMessageEcho,
): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.STUDIO_USER_MESSAGE_ECHO, tabId, echo);
  log("studio_window: user message echo pushed", {
    tab_id: tabId,
    message_id: echo.id,
  });
}

/**
 * Push a wholesale message-list replacement to the Studio mirror after a
 * successful engine rewind. Called from broadcastEngineHistory (the same
 * owner-side read that serves the iOS desktop_conversation_history push), so
 * both clients replace against the identical committed transcript in one
 * pass. A no-op when the Studio window is not open — same guard as every
 * other Studio push, since there is nothing to replace in a closed window.
 */
export function notifyStudioHistoryReplace(
  payload: StudioHistoryReplace,
): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.STUDIO_HISTORY_REPLACE, payload);
  log("studio_window: history replace pushed", {
    tab_id: payload.tabId,
    instance_id: payload.instanceId ?? "",
    message_count: payload.messages.length,
  });
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

export function revealStudioWindow(source: string): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  applyStudioActivationPolicy(true);
  app.focus({ steal: true });
  win.show();
  if (maximizeOnReveal.get(win)) {
    maximizeOnReveal.delete(win);
    win.maximize();
  }
  win.focus();
  rearmOverlayClickThrough("studio revealed");
  notifyStudioWindowState(true);
  persistStudioOpenState(true);
  log("studio_window: revealed", { source });
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
 * Open the Studio window, or focus it if it already exists. Idempotent; there is
 * never more than one Studio window. Refuses when Studio is not the active
 * UI (single-UI exclusivity) — the single gate every launcher (tray,
 * button, IPC, shortcut) funnels through. Exception: the active-ui switch
 * itself calls through here mid-flip, so the gate reads the CURRENT
 * resolution, not stale plan state.
 */
export function openStudioWindow(source = "unknown", reveal = true): void {
  try {
    const s = readSettings();
    if (
      resolveSurfacePlan(s, enterprisePolicyCache.policy).activeUi !== "studio"
    ) {
      log("studio_window: open refused — studio is not the active UI", {
        source,
      });
      return;
    }
  } catch {
    // Unreadable settings: no policy, proceed.
  }
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
  const win = new BrowserWindow({
    width: saved.bounds.width ?? STUDIO_DEFAULT_WIDTH,
    height: saved.bounds.height ?? STUDIO_DEFAULT_HEIGHT,
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
    icon: join(__dirname, "../../resources/icon.icns"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Studio-only: the browser surface tabs render through <webview>.
      // Every attach is forced through installWebviewPolicy (hard floor on
      // webPreferences, scheme allowlist, no popups, D6 preview offline).
      webviewTag: true,
    },
  });
  state.studioWindow = win;
  installWebviewPolicy(win.webContents);

  // Same renderer console forwarding as the main window, tagged [studio] so log
  // lines from the two renderers are distinguishable in desktop.jsonl.
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) {
      _error("studio-renderer", message);
    } else if (level === 2) {
      _warn("studio-renderer", message);
    } else if (level === 0) {
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

  win.webContents.once("did-finish-load", () =>
    markDeepLinkConfirmationReady("studio"),
  );

  win.once("ready-to-show", () => {
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
      rearmOverlayClickThrough("studio shown");
      notifyStudioWindowState(true);
      persistStudioOpenState(true);
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

  win.on("closed", () => {
    markDeepLinkConfirmationUnavailable("studio", "window closed");
    if (state.studioWindow === win) {
      state.studioWindow = null;
    }
    applyStudioActivationPolicy(false);
    rearmOverlayClickThrough("studio closed");
    notifyStudioWindowState(false);
    // User close clears the persisted open state; the quit path (forceQuit)
    // keeps it, so a Studio window open at quit reopens on the next launch.
    if (!state.forceQuit) persistStudioOpenState(false);
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

/**
 * Push the active tab (and its cached state) to the Studio window. Called by the
 * tab-focus handler on every active-tab change and by studio:get-state on open.
 */
export function notifyStudioActiveTab(tabId: string): void {
  const win = state.studioWindow;
  if (!win || win.isDestroyed()) return;
  const snapshot = getStudioState(tabId);
  win.webContents.send(
    IPC.STUDIO_ACTIVE_TAB,
    tabId,
    snapshot,
    state.studioActiveProfileId,
  );
  log("studio_window: active tab pushed", {
    tab_id: tabId,
    agent_count: snapshot.agents.length,
  });
}
