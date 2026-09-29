/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */

export interface IonWorktreesApi {
  /** Open the desktop-only graphical overlap view for a repository. */
  openWorktreeOverlap(context: {
    repoPath: string;
    sourceBranch?: string;
  }): void;
  getWorktreeOverlapContext(): Promise<{
    repoPath: string;
    sourceBranch?: string;
  } | null>;
}
