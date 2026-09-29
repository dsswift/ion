import { ipcRenderer } from "electron";
import { IPC } from "@ion/shared/types";
import type { IonAPI } from "./ionapi";
import type { DeviceMetricsSample } from "@ion/shared/types-device-metrics";

/**
 * Wrapper registry for the generic `on`/`off` bridge below.
 *
 * `on` cannot hand the caller's raw callback to `ipcRenderer.on` (the IPC
 * signature carries an `IpcRendererEvent` first argument that the wrapper
 * forwards), so `off` needs a way back from the callback to the wrapper that
 * was actually registered. Keyed callback → channel → wrapper. The outer
 * WeakMap lets a callback whose owner unmounted be collected along with its
 * wrappers.
 */
const ipcWrappers = new WeakMap<
  (...args: any[]) => void,
  Map<string, (_e: Electron.IpcRendererEvent, ...args: any[]) => void>
>();

/** Filesystem, account, remote, window, and generic bridge methods. */
export const systemApi = {
  fsSaveDialog: (defaultPath, defaultFileName, filters) =>
    ipcRenderer.invoke(IPC.FS_SAVE_DIALOG, { defaultPath, defaultFileName, filters }),
  fsRevealInFinder: (targetPath) =>
    ipcRenderer.invoke(IPC.FS_REVEAL_IN_FINDER, { targetPath }),
  fsOpenNative: (targetPath) =>
    ipcRenderer.invoke(IPC.FS_OPEN_NATIVE, { targetPath }),
  fsOpenNativeData: (name, base64) =>
    ipcRenderer.invoke(IPC.FS_OPEN_NATIVE_DATA, { name, base64 }),
  fsSaveData: (name, base64) =>
    ipcRenderer.invoke(IPC.FS_SAVE_DATA, { name, base64 }),

  // ─── OS facilities ───
  copyPngToClipboard: (png: ArrayBuffer) =>
    ipcRenderer.invoke(IPC.COPY_PNG_TO_CLIPBOARD, png),

  // ─── Auto-update ───
  installUpdate: () => ipcRenderer.send(IPC.INSTALL_UPDATE),
  restartForUpdate: () => ipcRenderer.send(IPC.RESTART_FOR_UPDATE),
  onUpdateDownloaded: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { version: string },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { percent: number; status: string },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, handler);
  },
  onUpdateStaged: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { workerPid: number },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_STAGED, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STAGED, handler);
  },
  onUpdateError: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { message: string },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_ERROR, handler);
  },

  // ─── Device Metrics (this machine's own Studio processes) ───
  deviceMetricsWatch: (on) => ipcRenderer.invoke(IPC.DEVICE_METRICS_WATCH, on),
  onDeviceMetrics: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, sample: DeviceMetricsSample) => callback(sample);
    ipcRenderer.on(IPC.DEVICE_METRICS, handler);
    return () => ipcRenderer.removeListener(IPC.DEVICE_METRICS, handler);
  },

  // ─── Renderer logging bridge ───
  logWrite: (level, tag, msg, fields) => {
    // Fire-and-forget log bridge: the renderer logger does not await delivery.
    // Void the invoke promise so its (rare) rejection doesn't float.
    void ipcRenderer.invoke(IPC.LOG_WRITE, {
      level,
      tag,
      msg,
      fields: fields ?? {},
    });
  },

  // `on` wraps the caller's callback, so `off` cannot pass the ORIGINAL
  // callback to removeListener — ipcRenderer holds the wrapper, the identities
  // differ, and the removal silently no-ops. That left every `on` registration
  // permanently attached: an effect that re-ran (StrictMode double-invoke, a
  // remount, a dependency change) added a second live listener for the same
  // channel and the handler then fired N times per single main-process
  // broadcast.
  //
  // The registry keys wrapper-by-callback per channel so `off` can look up the
  // exact wrapper it registered. A WeakMap on the callback keeps entries
  // collectable when the caller's closure goes away, so a component that
  // unmounts without calling `off` leaks nothing.
  on: (channel, callback) => {
    const handler = (_e: Electron.IpcRendererEvent, ...args: any[]) =>
      callback(_e, ...args);
    let perChannel = ipcWrappers.get(callback);
    if (!perChannel) {
      perChannel = new Map();
      ipcWrappers.set(callback, perChannel);
    }
    // Re-registering the same callback on the same channel would otherwise
    // orphan the previous wrapper (unremovable, still firing). Drop it first
    // so `on` is idempotent per (channel, callback) pair.
    const prior = perChannel.get(channel);
    if (prior) ipcRenderer.removeListener(channel, prior);
    perChannel.set(channel, handler);
    ipcRenderer.on(channel, handler);
  },
  off: (channel, callback) => {
    const perChannel = ipcWrappers.get(callback);
    const handler = perChannel?.get(channel);
    if (!handler) return;
    ipcRenderer.removeListener(channel, handler);
    perChannel!.delete(channel);
  },

  // ─── Event listeners ───
  // The engine-event stream (normalized events, tab status, enriched
  // errors) is not a preload concern: it arrives as studio_event frames from
  // the Studio server (`useEngineEvents`, `browser-shell-bridge.ts`'s
  // `onEvent`). The raw `ion:normalized-event` / `ion:tab-status-change` /
  // `ion:enriched-error` IPC listeners that lived here had no main-process
  // producer after the store moved into the server.
  onSkillStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) =>
      callback(status);
    ipcRenderer.on(IPC.SKILL_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.SKILL_STATUS, handler);
  },

  onWindowShown: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.WINDOW_SHOWN, handler);
    return () => ipcRenderer.removeListener(IPC.WINDOW_SHOWN, handler);
  },

  onShowSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.SHOW_SETTINGS, handler);
    return () => ipcRenderer.removeListener(IPC.SHOW_SETTINGS, handler);
  },
} satisfies Partial<IonAPI>;
