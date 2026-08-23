import type { WorktreeInfo } from '../../shared/types'

/** Known routing context for a new-conversation picker invocation. */
export interface NewConversationPickerTarget {
  /** Start from a selected project or workspace rather than project search. */
  initialDirectory?: string
  /** Existing worktree selected before the conversation-type picker opens. */
  initialWorktree?: WorktreeInfo
  /** Use a new worktree for the selected conversation. */
  initialUseWorktree?: boolean
  /** Branch selected before the conversation-type picker opens. */
  initialSourceBranch?: string
}
