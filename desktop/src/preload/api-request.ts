import { ipcRenderer } from "electron";
import { IPC } from "@ion/shared/types";
import type { IonAPI } from "./ionapi";

/** Request, session, git, and listener methods exposed to the renderer. */
export const requestApi = {
  startupReport: (report) => ipcRenderer.send(IPC.STARTUP_REPORT, report),
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  selectExtensionFiles: () => ipcRenderer.invoke(IPC.SELECT_EXTENSION_FILES),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  getFavicon: (host) => ipcRenderer.invoke(IPC.FAVICON_GET, host),
  revealPath: (path) => ipcRenderer.invoke(IPC.REVEAL_PATH, path),
  oauthCallbackListen: () => ipcRenderer.invoke(IPC.OAUTH_CALLBACK_LISTEN),
  oauthCallbackAwait: (id) => ipcRenderer.invoke(IPC.OAUTH_CALLBACK_AWAIT, id),
  oauthCallbackCancel: (id) => ipcRenderer.invoke(IPC.OAUTH_CALLBACK_CANCEL, id),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  listFonts: () => ipcRenderer.invoke(IPC.LIST_FONTS),

} satisfies Partial<IonAPI>;
