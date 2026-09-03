/**
 * The IonAPI contextBridge surface type. Domain interfaces keep this public
 * import stable while allowing each portion to stay within the file-size cap.
 */
import type { StudioApi } from "./studio-api";
import type { IonCoreApi } from "./ionapi-core";
import type { IonAutomationApi } from "./ionapi-automation";
import type { IonEngineApi } from "./ionapi-engine";
import type { IonEventsApi } from "./ionapi-events";
import type { IonGitApi } from "./ionapi-git";
import type { IonWorktreesApi } from "./ionapi-worktrees";

export type { IonCoreApi } from "./ionapi-core";
export type { IonAutomationApi } from "./ionapi-automation";
export type { IonEngineApi } from "./ionapi-engine";
export type { IonEventsApi } from "./ionapi-events";
export type { IonGitApi } from "./ionapi-git";
export type { IonWorktreesApi } from "./ionapi-worktrees";

export interface IonAPI
  extends
    StudioApi,
    IonCoreApi,
    IonAutomationApi,
    IonGitApi,
    IonWorktreesApi,
    IonEngineApi,
    IonEventsApi {}
