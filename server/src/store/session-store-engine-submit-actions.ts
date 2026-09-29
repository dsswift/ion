/**
 * Engine-submit action signatures, split from the store contract
 * (session-store-types.ts `State`) to keep it under the TypeScript file-size cap.
 */
import type { ResourceItem } from "@ion/shared/types-engine";

export interface EngineSubmitActions {
  addEngineSystemMessage: (
    tabId: string,
    content: string,
    planFilePath?: string,
  ) => void;
  /** Insert a user-role message into the active conversation instance for a
   *  remote-originated prompt that bypassed the renderer's submit() path. Used
   *  by the pipeline when an extension command succeeds synchronously (the
   *  extension's ctx.sendPrompt starts the run, but no renderer submit was
   *  ever called for the iOS prompt). Without this the desktop store has the
   *  assistant response but no user bubble, and iOS history reads (which pull
   *  from the renderer store) also miss it. */
  insertRemoteUserMessage: (
    tabId: string,
    content: string,
    slashCommand?: string,
    slashArgs?: string,
    implementationPhase?: boolean,
    /** The id the client sent the prompt under; stamped on the row. */
    clientMsgId?: string,
  ) => void;
  markResourceRead: (resourceId: string) => void;
  markAllResourcesRead: (items: ResourceItem[]) => void;
  deleteResource: (kind: string, resourceId: string, producer?: string) => void;
}
