/**
 * landing-choice — the dialog's Worktree and From branch fields, and what
 * they add up to.
 *
 * Once a project is chosen on the destination, a conversation that travels
 * without a worktree can land in that project's checkout, in one of its live
 * worktrees, or in a new worktree cut from a branch there. The destination
 * says what it offers (`transfer.landings`); this module turns that answer
 * and the operator's picks into the one `TransferLanding` the import (or a
 * move within one machine) receives. Pure, so each rule is pinned by a test.
 */
import type { TransferLanding, TransferLandingOptions } from '@ion/shared/types-transfer'

/** The Worktree field's value: the project checkout, an existing worktree by path, or a new one. */
export type WorktreeChoice = { kind: 'checkout' } | { kind: 'worktree'; worktreePath: string } | { kind: 'new' }

export const CHECKOUT_VALUE = 'checkout'
export const NEW_WORKTREE_VALUE = 'new'

export function worktreeChoiceValue(choice: WorktreeChoice): string {
  if (choice.kind === 'worktree') return choice.worktreePath
  return choice.kind === 'new' ? NEW_WORKTREE_VALUE : CHECKOUT_VALUE
}

export function parseWorktreeChoice(value: string): WorktreeChoice {
  if (value === CHECKOUT_VALUE) return { kind: 'checkout' }
  if (value === NEW_WORKTREE_VALUE) return { kind: 'new' }
  return { kind: 'worktree', worktreePath: value }
}

/**
 * Whether the Worktree field applies at all. A project git cannot read (a
 * notes folder, a non-code project) has no branches to cut from and no
 * worktrees, so it only ever offers its checkout, and the field is noise.
 */
export function offersWorktrees(options: TransferLandingOptions | null): boolean {
  return !!options && (options.branches.length > 0 || options.worktrees.length > 0)
}

/**
 * The branch a new worktree is cut from by default: the one the conversation
 * was already based on, when the destination has it, so the work continues
 * from the same place; else whatever the destination checkout is on; else
 * the first branch it has.
 */
export function defaultBaseBranch(options: TransferLandingOptions | null, conversationBase: string | null): string {
  if (!options) return ''
  if (conversationBase && options.branches.includes(conversationBase)) return conversationBase
  if (options.currentBranch && options.branches.includes(options.currentBranch)) return options.currentBranch
  return options.branches[0] ?? ''
}

/** The landing the fields add up to, or null while a required pick is still missing. */
export function buildLanding(projectDir: string, choice: WorktreeChoice, baseBranch: string): TransferLanding | null {
  if (!projectDir) return null
  if (choice.kind === 'checkout') return { kind: 'checkout', dir: projectDir }
  if (choice.kind === 'worktree') return { kind: 'worktree', worktreePath: choice.worktreePath }
  return baseBranch ? { kind: 'new-worktree', projectDir, baseBranch } : null
}

/**
 * True when a move within one machine would put the conversation exactly
 * where it already lives. Only a checkout or an existing worktree can be
 * that place; a new worktree never is.
 */
export function landsWhereItIs(landing: TransferLanding | null, currentDirectory: string): boolean {
  if (!landing || !currentDirectory) return false
  if (landing.kind === 'checkout') return landing.dir === currentDirectory
  if (landing.kind === 'worktree') return landing.worktreePath === currentDirectory
  return false
}
