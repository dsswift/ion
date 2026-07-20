/**
 * Desktop auto-updater.
 *
 * Checks GitHub Releases for a new version on launch and every 4 hours.
 * Only active in packaged builds (`app.isPackaged`).
 * Downloads updates in the background and notifies the renderer via IPC.
 * The user confirms before the app quits and installs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { IPC } from "../shared/types-ipc";
import { info, error as logError } from "./logger";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const tag = "updater";

/** Logger adapter for electron-updater (expects info/warn/error/debug methods). */
const updaterLogger = {
  info: (msg: string) => info(tag, msg),
  warn: (msg: string) => info(tag, msg, { level: 'warn' }),
  error: (msg: string) => logError(tag, msg),
  debug: (msg: string) => info(tag, msg, { level: 'debug' }),
};

let intervalId: ReturnType<typeof setInterval> | undefined;

export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    info(tag, "skipping — not packaged");
    return;
  }

  // Local `make desktop` builds are packaged but never include app-update.yml
  // (only CI publish builds generate it). Guard here so electron-updater does
  // not ENOENT-error on every check interval and flood the logs.
  const feedPath = join(process.resourcesPath, "app-update.yml");
  if (!existsSync(feedPath)) {
    info(tag, "skipping — no update feed (local build)");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = updaterLogger;

  autoUpdater.on("update-available", (updateInfo: UpdateInfo) => {
    info(tag, 'update available', { version: updateInfo.version });
  });

  autoUpdater.on("update-downloaded", (updateInfo: UpdateInfo) => {
    info(tag, 'update downloaded', { version: updateInfo.version });
    notifyRenderer(IPC.UPDATE_DOWNLOADED, { version: updateInfo.version });
  });

  autoUpdater.on("error", (err: Error) => {
    logError(tag, 'error', { error: err.message });
  });

  // Renderer can request install
  ipcMain.on(IPC.INSTALL_UPDATE, () => {
    autoUpdater.quitAndInstall();
  });

  // First check shortly after launch
  setTimeout(() => { void autoUpdater.checkForUpdates().catch((err) => logError(tag, 'initial update check failed', { error: String(err) })); }, 10_000);

  // Periodic checks
  intervalId = setInterval(
    () => { void autoUpdater.checkForUpdates().catch((err) => logError(tag, 'periodic update check failed', { error: String(err) })); },
    CHECK_INTERVAL_MS,
  );
}

function notifyRenderer(
  channel: string,
  payload: Record<string, unknown>,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function stopAutoUpdater(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
}
