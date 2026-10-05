import type { WorktreeInfo } from '@ion/shared/types'

/** Known routing context for a new-conversation picker invocation. */
export interface NewConversationPickerTarget {
  /** Start from a selected project or workspace rather than project search. */
  initialDirectory?: string
  /**
   * The Environment `initialDirectory` is a path on. A caller that names a
   * directory knows which machine it read that directory from and says so
   * here; the picker never infers it. Absent means this machine.
   */
  initialEnvironmentId?: string
  /** Existing worktree selected before the conversation-type picker opens. */
  initialWorktree?: WorktreeInfo
  /** Force the conversation-type picker and ignore the saved Project choice. */
  forceProfilePicker?: boolean
  /** Create a new worktree from the selected Project. */
  initialUseWorktree?: boolean
  /** Branch selected before the conversation-type picker opens. */
  initialSourceBranch?: string
  /**
   * Show the branch step even though `initialSourceBranch` is set. That
   * branch, the project's remembered one, is then only preselected.
   */
  initialChooseBranch?: boolean
}
