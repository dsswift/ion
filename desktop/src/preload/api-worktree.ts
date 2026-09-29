import { ipcRenderer } from "electron";
import { IPC } from "@ion/shared/types";
import type { IonAPI } from "./ionapi";

/** Worktree and integration-bench methods exposed to the renderer. */
export const worktreeApi = {
  openWorktreeOverlap: (context) =>
    ipcRenderer.send(IPC.WORKTREE_OVERLAP_OPEN, context),
  getWorktreeOverlapContext: () =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_CONTEXT),
} satisfies Partial<IonAPI>;
