/**
 * The engine's `list_branches` answer: every root-to-leaf path of a
 * conversation's tree. Mirrors `conversation.BranchListing` in
 * `engine/internal/conversation/branches.go`.
 */

/** One root-to-leaf path. */
export interface ConversationBranch {
  leafId: string
  /** The leaf entry's timestamp, Unix ms. */
  timestamp: number
  /** Text of the path's last message that has any, cut short. */
  preview: string
  messageCount: number
  /** The deepest entry on the path with more than one child; absent when none. */
  forkPointId?: string
  /** The conversation's current leaf is this leaf. */
  active: boolean
}

/** An entry with more than one child; `entryId` is '' for the root. */
export interface ConversationBranchPoint {
  entryId: string
  timestamp: number
  childIds: string[]
}

export interface ConversationBranches {
  /** The current leaf. Interior right after a rewind; '' when cleared to the start. */
  activeLeafId: string
  branches: ConversationBranch[]
  branchPoints: ConversationBranchPoint[]
}
