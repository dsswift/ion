import type { WorktreeInfo } from '../../shared/types'

/** Known routing context for a new-conversation picker invocation. */
export interface NewConversationPickerTarget {
  /** Start from a selected project or workspace rather than project search. */
  initialDirectory?: string
  /** Existing worktree selected before the conversation-type picker opens. */
  initialWorktree?: WorktreeInfo
  /** Force the conversation-type picker and ignore the saved Project choice. */
  forceProfilePicker?: boolean
  /** Create a new worktree from the selected Project. */
  initialUseWorktree?: boolean
  /** Branch selected before the conversation-type picker opens. */
  initialSourceBranch?: string
}
