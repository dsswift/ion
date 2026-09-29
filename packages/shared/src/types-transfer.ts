/**
 * Shared shapes for the Desktop Transfer verb (spec 15): the desktop main
 * process's `connections/transfer.ts` produces these; the preload bridge and
 * `StudioHost` pass them through unchanged so the renderer's transfer flow
 * has one contract to code against on both sides of the IPC boundary.
 */

export interface TransferProgress {
  tabId: string
  direction: 'export' | 'import'
  bytesTransferred: number
  totalBytes: number
}

export interface TransferRefusal {
  code: string
  message: string
}

/**
 * How the source cuts a worktree bundle, from the destination's
 * `transfer.preflight` answer: carry the source branch when the destination
 * lacks it, excluding the commits it already has.
 */
export interface ExportFileOptions {
  includeSourceBranch?: boolean
  knownTips?: string[]
  /**
   * Whether a worktree conversation's worktree travels with it. False (or
   * absent) moves the conversation on its own and leaves the worktree, and
   * every other conversation in it, where they are.
   */
  carryWorktree?: boolean
}

export type ExportFileResult =
  | { ok: true; filePath: string; totalBytes: number; rootConversationId: string }
  | { ok: false; refusal: TransferRefusal }

export type ImportFileResult =
  | { ok: true; rootConversationId: string; tabId: string; worktreePath?: string }
  | { ok: false; refusal: TransferRefusal }

/**
 * Where a conversation arriving without a worktree lands on the destination:
 * a project checkout, an existing worktree of that project, or a new
 * worktree cut from a branch there. Chosen in the source dialog from what
 * the destination offers, and re-validated there at import.
 */
export type TransferLanding =
  | { kind: 'checkout'; dir: string }
  | { kind: 'worktree'; worktreePath: string }
  | { kind: 'new-worktree'; projectDir: string; baseBranch: string }

/** `transfer.landings` on the DESTINATION: what one of its projects offers a conversation to land in. */
export interface TransferLandingOptions {
  /** Live (not landed) worktrees of the project, newest first. */
  worktrees: Array<{ worktreePath: string; branchName: string; title: string | null }>
  /** Local branches, for cutting a new worktree. */
  branches: string[]
  /** The branch the project checkout is on, when it is on one. */
  currentBranch: string | null
}
