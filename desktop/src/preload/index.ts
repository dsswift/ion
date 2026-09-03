import { contextBridge } from "electron";
import { studioApi } from "./studio-api";
import { requestApi } from "./api-request";
import { automationApi } from "./api-automation";
import { systemApi } from "./api-system";
import { worktreeApi } from "./api-worktree";
import { engineApi } from "./engine-api";
import type { IonAPI } from "./ionapi";

export type { IonAPI } from "./ionapi";

// Keep the renderer contract as one bridge object while modules own cohesive APIs.
const api: IonAPI = {
  ...studioApi,
  ...requestApi,
  ...automationApi,
  ...worktreeApi,
  ...engineApi,
  ...systemApi,
};

contextBridge.exposeInMainWorld("ion", api);
