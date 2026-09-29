/**
 * IPC surface for the Ion Studio window.
 *
 * All handlers validate renderer-supplied input per ipc-validation.ts
 * conventions before any side effect. Settings writes go through a key
 * allowlist so the Studio window can never mutate arbitrary settings.
 */
import { app, dialog, ipcMain } from "electron";
import { writeFile } from "fs/promises";
import { join } from "path";
import { IPC } from "@ion/shared/types";
import { allowPreviewNetwork } from "../webview-policy";
import { log as _log } from "../logger";
import {
  setStudioTitleBarOverlay,
} from "../studio-window-manager";
import { registerStudioBrowserIpc } from './studio-browser'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("studio", msg, fields);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function registerStudioIpc(): void {
  registerStudioBrowserIpc();
  ipcMain.handle(
    IPC.STUDIO_SET_TITLE_BAR_OVERLAY,
    (_event, color: unknown, symbolColor: unknown) => {
      if (
        typeof color !== "string" ||
        typeof symbolColor !== "string" ||
        !HEX_COLOR.test(color) ||
        !HEX_COLOR.test(symbolColor)
      ) {
        log("studio_ipc: title bar overlay rejected", {
          color: typeof color === "string" ? color : typeof color,
          symbol_color: typeof symbolColor === "string" ? symbolColor : typeof symbolColor,
        });
        return false;
      }
      return setStudioTitleBarOverlay(color, symbolColor);
    },
  );

  // D6: explicit per-tab confirm lifts the preview partition's offline
  // block. Validation lives in webview-policy (partition prefix check).
  ipcMain.handle(
    IPC.STUDIO_PREVIEW_ALLOW_NETWORK,
    (_event, partition: unknown) => {
      if (typeof partition !== "string" || partition.length > 128) return false;
      return allowPreviewNetwork(partition);
    },
  );

  // Postcard export: renderer composes the PNG (canvas + stats footer);
  // main validates (PNG signature, size cap) and saves via the dialog.
  ipcMain.handle(IPC.STUDIO_EXPORT_IMAGE, async (_event, png: unknown) => {
    if (
      !(png instanceof ArrayBuffer) ||
      png.byteLength === 0 ||
      png.byteLength > 20 * 1024 * 1024
    ) {
      log("studio_ipc: export-image rejected size", {
        bytes: png instanceof ArrayBuffer ? png.byteLength : -1,
      });
      return false;
    }
    const bytes = Buffer.from(png);
    const PNG_SIG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (!bytes.subarray(0, 8).equals(PNG_SIG)) {
      log("studio_ipc: export-image rejected signature");
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog({
      defaultPath: join(app.getPath("desktop"), `ion-office-${stamp}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, bytes);
    log("studio_ipc: postcard exported", {
      path: result.filePath,
      bytes: bytes.length,
    });
    return true;
  });

  // Clip export: renderer records the canvas stream (MediaRecorder webm);
  // main validates (EBML signature, size cap) and saves via the dialog.
  ipcMain.handle(IPC.STUDIO_EXPORT_VIDEO, async (_event, webm: unknown) => {
    if (
      !(webm instanceof ArrayBuffer) ||
      webm.byteLength === 0 ||
      webm.byteLength > 100 * 1024 * 1024
    ) {
      log("studio_ipc: export-video rejected size", {
        bytes: webm instanceof ArrayBuffer ? webm.byteLength : -1,
      });
      return false;
    }
    const bytes = Buffer.from(webm);
    const EBML_SIG = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    if (!bytes.subarray(0, 4).equals(EBML_SIG)) {
      log("studio_ipc: export-video rejected signature");
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog({
      defaultPath: join(
        app.getPath("desktop"),
        `ion-office-clip-${stamp}.webm`,
      ),
      filters: [{ name: "WebM video", extensions: ["webm"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, bytes);
    log("studio_ipc: clip exported", {
      path: result.filePath,
      bytes: bytes.length,
    });
    return true;
  });

  // The conversation picker (`studioListTabs`), the campus status summaries
  // (`studioGetAllStatus`), the theme-pack reads and the per-conversation
  // state backfill (`studioGetState`) are `studio.*` studio_actions now
  // (server/src/protocol/studio-actions.ts, misc-actions.ts); the renderer
  // reaches them through the bridged shell on every host.
}
