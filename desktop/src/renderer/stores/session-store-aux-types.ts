/**
 * session-store-aux-types — small standalone interfaces used by the session
 * store, split from session-store-types.ts (file-size cap).
 *
 * These are genuinely separate concerns from the big `State` interface itself
 * (git-conflict alerts, the sync-all pipeline banner, the close-confirmation
 * dialog, static app info, and file-editor tab state) — none of them
 * reference `State`, so extracting them here is a clean seam rather than an
 * arbitrary split.
 */
import type { SyncAllResult, SyncAllWorktreeOutcome } from '../../shared/types'

/** One conflicted or refused directory, as the alert surfaces see it. */
export interface GitConflictAlert {
  /** What raised it: a failed sync, a failed land, or an inventory detection. */
  source: 'sync' | 'land' | 'detected'
  /**
   * What kind of failure this is. `conflict` (the default when absent) means
   * an operation is stuck mid-way and the ConflictsDialog can resolve it.
   * `refusal` means the verb declined to start — a dirty worktree refusing a
   * sync — so there is NO in-progress operation to resolve; the remediation
   * is in `message` (commit or stash), and the toast offers no Resolve.
   *
   * Lifecycle differs too: a conflict clears when the inventory sees the
   * operation finish, a refusal clears when the worktree goes clean or the
   * next sync succeeds (there is no git state that says "was refused").
   */
  kind?: 'conflict' | 'refusal'
  /** The in-progress operation, when known. */
  operationState?: 'rebasing' | 'merging' | 'cherry-picking'
  /** Operator-facing message from the failing verb, when there was one. */
  message?: string
  /** Display label for the directory (worktree label or basename). */
  label?: string
  /** True when the operator closed the toast. Badges ignore this. */
  dismissed: boolean
  recordedAt: number
}

/**
 * The sync-all pipeline's live state — what the progress banner, the confirm
 * gate, and the ATV mirror render. One object because the phases are a strict
 * sequence; see stores/slices/worktree-pipeline-slice.ts for the machine.
 */
export interface WorktreePipelineState {
  repoPath: string
  /** Bench selector for phase 4; null when the repo has no bench context. */
  sourceBranch: string | null
  phase: 'syncing' | 'awaiting-ai-confirm' | 'resolving' | 'assembling' | 'done' | 'failed'
  /** Per-worktree outcomes of the LAST mechanical pass (refreshed between agents). */
  outcomes: SyncAllWorktreeOutcome[]
  /** Counts from the last mechanical pass, for the summary sentence. */
  lastSummary?: SyncAllResult['summary']
  /** Worktree paths still conflicted and queued for AI escalation, in pass order. */
  queue: string[]
  /** The worktree an assist agent is working on right now, or null. */
  current: string | null
  /** Worktrees an agent could not clear — their conflict badges stay live. */
  needsManual: string[]
  /** How many rebases an assist agent completed (excludes rerere replays). */
  resolvedByAi: number
  /** Set by cancel; the machine stops between steps and finishes with a cancelled summary. */
  cancelled: boolean
  startedAt: number
  /** Terminal sentence for the banner, set when phase reaches done/failed. */
  summary?: string
}

/**
 * A pending close request, resolved and awaiting the operator's answer.
 *
 * Raised only by `requestCloseTab`, which resolves `warning` BEFORE setting
 * this — so the dialog is complete on first render (desktop/AGENTS.md § "View
 * readiness principle") rather than growing a warning line after it opens.
 */
export interface CloseIntent {
  tabId: string
  /** Resolved display title, so the dialog needs no second lookup. */
  title: string
  directory: string
  /**
   * What the operator is walking away from, or null when the close is
   * uneventful. Null for every plain conversation (no second lifetime) and for
   * a worktree that is clean and fully landed.
   */
  warning: string | null
}

export interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
}

export interface FileEditorTab {
  id: string
  filePath: string | null
  fileName: string
  content: string
  savedContent: string
  isDirty: boolean
  isReadOnly: boolean
  isPreview: boolean
  /**
   * Set when the file's on-disk content could not be read (deleted or
   * unreadable path). Restored non-dirty files reload from disk (schema v4
   * drops their buffers from the tab file); a failed reload must surface as
   * an explicit error, never a silent blank buffer the user might save over
   * the real file. Runtime-only — never persisted.
   */
  readError?: string
}

export interface FileEditorDirState {
  activeFileId: string | null
  files: FileEditorTab[]
}
