import { contextBridge } from "electron";
import { studioApi } from "./studio-api";
import { requestApi } from "./api-request";
import { automationApi } from "./api-automation";
import { gitIdentityApi } from "./api-git-identity";
import { systemApi } from "./api-system";
import { worktreeApi } from "./api-worktree";
import type { IonAPI } from "./ionapi";

export type { IonAPI } from "./ionapi";

// Keep the renderer contract as one bridge object while modules own cohesive
// APIs. Everything the Studio server serves over the wire is absent here by
// design: the renderer reaches it through the bridged shell
// (`renderer/host/browser-shell-bridge.ts`) on every host.
const api: IonAPI = {
  ...studioApi,
  ...requestApi,
  ...automationApi,
  ...gitIdentityApi,
  ...worktreeApi,
  ...systemApi,
};

contextBridge.exposeInMainWorld("ion", api);
