/**
 * Engine-submit action signatures split from session-store-actions.ts to keep
 * the composed store contract under the TypeScript file-size cap.
 */
import type { ResourceItem } from "../../shared/types-engine";

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
  ) => void;
  setEngineDraftInput: (tabId: string, text: string) => void;
  /**
   * Compute the conversation tail fingerprint for a tab using the canonical
   * TS implementation in `shared/conversation-fingerprint.ts`. Exposed on the
   * store so snapshot.ts's `executeJavaScript` can call it via
   * `store.getState().computeConvFingerprint(tabId)` instead of inlining the
   * algorithm as a string-interpolated IIFE. Eliminates the inline-JS copy in
   * snapshot.ts; the canonical function in shared/ remains the single TS
   * source of truth. Returns '' when the tab has no messages.
   */
  computeConvFingerprint: (tabId: string) => string;
  markResourceRead: (resourceId: string) => void;
  markAllResourcesRead: (items: ResourceItem[]) => void;
  deleteResource: (kind: string, resourceId: string) => void;
}
