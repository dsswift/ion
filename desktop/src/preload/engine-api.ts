/**
 * Engine, model/provider, plugin, and MCP IPC bridge, extracted from
 * preload/index.ts to keep that file under the repo file-size cap.
 *
 * `engineApi` is spread into the main `api` object in index.ts. It is typed
 * as `Pick<IonAPI, ...>` rather than its own hand-authored interface so the
 * method signatures here can never drift from the single canonical
 * declaration in ionapi.ts — that file is the only source of truth for the
 * public IonAPI surface.
 */
import { ipcRenderer } from "electron";
import { IPC } from "@ion/shared/types";
import type { IonAPI } from "./ionapi";

export type EngineIpcApi = Pick<
  IonAPI,
  | "questionsPickAttachments"
>;

export const engineApi: EngineIpcApi = {

  questionsPickAttachments: () => ipcRenderer.invoke(IPC.QUESTIONS_PICK_ATTACHMENTS),

};
