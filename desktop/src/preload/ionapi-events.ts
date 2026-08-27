/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type { NormalizedEvent, EnrichedError } from "../shared/types";
import type {} from "../shared/types-ipc";
import type {} from "../shared/types-automation";

export interface IonEventsApi {
  // ─── Event listeners (main → renderer) ───
  onEvent(
    callback: (tabId: string, event: NormalizedEvent) => void,
  ): () => void;
  onTabStatusChange(
    callback: (tabId: string, newStatus: string, oldStatus: string) => void,
  ): () => void;
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void;
  onSkillStatus(
    callback: (status: {
      name: string;
      state: string;
      error?: string;
      reason?: string;
    }) => void,
  ): () => void;
  onWindowShown(callback: () => void): () => void;
  onShowSettings(callback: () => void): () => void;
}
