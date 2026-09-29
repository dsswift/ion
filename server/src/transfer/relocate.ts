/**
 * transfer/relocate — `transfer.relocate{tabId, landing}`: move a
 * conversation to another place on THIS machine.
 *
 * Transferring to the machine a conversation already lives on needs no
 * archive: nothing crosses a wire, so nothing is exported, verified, or
 * deleted. The conversation is simply repointed, in the store and in its
 * live engine session together, at the landing it was given — this
 * project's checkout, one of its worktrees, or a new worktree.
 *
 * The landing is resolved by the same `resolveLanding` an import uses, so a
 * move within a machine and a move between machines refuse and create
 * exactly the same things. The worktree the conversation leaves, and every
 * other conversation in it, is untouched.
 */
import type { TabState } from '@ion/shared/types'
import type { TransferLanding } from '@ion/shared/types-transfer'
import { resolveLanding, type LandingDeps } from './landing'
import { formatSessionBusyRefusal, type SessionBusyResult } from '../store/slices/session-busy-guard'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.relocate'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export type RelocateRefusalCode = 'not_found' | 'running' | 'same_place' | 'no_destination_directory'

export type RelocateResult =
  | { ok: true; tabId: string; workingDirectory: string; worktreePath: string | null }
  | { ok: false; refusal: { code: RelocateRefusalCode; message: string } }

export interface RelocateDeps extends LandingDeps {
  findTab: (tabId: string) => Pick<TabState, 'id' | 'status' | 'bashExecuting' | 'workingDirectory' | 'worktree'> | null
  /** The busy guard over the tab's live instances (background agents, shells). */
  busyGuard: (tabId: string) => SessionBusyResult
  /** Repoints the tab and its live engine session at `dir`, with its worktree identity. */
  repoint: (tabId: string, dir: string, worktree: TabState['worktree']) => Promise<boolean>
}

/** Where the landing would put the conversation, when that is knowable before resolving it. */
function landingDirectory(landing: TransferLanding): string | null {
  if (landing.kind === 'checkout') return landing.dir
  if (landing.kind === 'worktree') return landing.worktreePath
  return null
}

export async function runRelocate(tabId: string, landing: TransferLanding, deps: RelocateDeps): Promise<RelocateResult> {
  const fields = { tab_id: tabId, landing_kind: landing.kind }
  const tab = deps.findTab(tabId)
  if (!tab) {
    warn('refused: no such conversation', { ...fields, outcome: 'not_found' })
    return { ok: false, refusal: { code: 'not_found', message: `no open conversation ${tabId}` } }
  }

  // A conversation mid-turn has a session doing work in the directory it is
  // about to leave; moving it then would split one turn across two places.
  const guard = deps.busyGuard(tabId)
  const busy = tab.status === 'running' || tab.status === 'connecting' || tab.status === 'waiting' || tab.bashExecuting || guard.blocked
  if (busy) {
    const message = formatSessionBusyRefusal(tabId, guard, 'move the conversation')
    warn('refused: conversation is busy', { ...fields, outcome: 'running', tab_status: tab.status, bash_executing: tab.bashExecuting, reason: message })
    return { ok: false, refusal: { code: 'running', message } }
  }

  if (landingDirectory(landing) === tab.workingDirectory) {
    log('refused: the conversation already lives there', { ...fields, outcome: 'same_place', working_directory: tab.workingDirectory })
    return { ok: false, refusal: { code: 'same_place', message: `the conversation already lives in ${tab.workingDirectory}` } }
  }

  const resolved = await resolveLanding(landing, deps)
  if (!resolved.ok) {
    warn('refused: landing does not hold', { ...fields, outcome: 'no_destination_directory', error: resolved.message })
    return { ok: false, refusal: { code: 'no_destination_directory', message: resolved.message } }
  }

  const relocated = await deps.repoint(tabId, resolved.workingDirectory, resolved.worktree)
  log('conversation moved within this machine', {
    ...fields,
    outcome: 'ok',
    from: tab.workingDirectory,
    to: resolved.workingDirectory,
    left_worktree: tab.worktree?.worktreePath ?? '',
    joined_worktree: resolved.worktree?.worktreePath ?? '',
    // False means the store moved but the live session did not yet; the next
    // prompt's cwd reconciliation carries the session across.
    session_relocated: relocated,
  })
  return { ok: true, tabId, workingDirectory: resolved.workingDirectory, worktreePath: resolved.worktree?.worktreePath ?? null }
}
