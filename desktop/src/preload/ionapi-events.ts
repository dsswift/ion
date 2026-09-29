/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */

export interface IonEventsApi {
  // ─── Event listeners ───
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
