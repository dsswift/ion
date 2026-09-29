/**
 * transfer/pending — `transfer.abandon{tabId}`: clear the in-flight marker
 * a transfer wrote, leaving this copy as the live one.
 *
 * `export.ts` writes `sealPending` before it reads a single conversation
 * file, so a transfer that dies part-way leaves a tab that refuses prompts.
 * This is how the operator takes that tab back when the move is not going
 * to finish. The opposite choice — finish the move — is
 * `transfer.remove`, which deletes this copy instead.
 *
 * There is no counterpart that marks a transfer complete. A completed
 * transfer has no source left to mark.
 */
import type { TransferPaths } from './paths'
import { readTabsState, writeTabsState, findTab } from './tabs-file'
import { log as _log } from '../logger'

const TAG = 'transfer.pending'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}

export interface AbandonArgs {
  tabId: string
  paths: TransferPaths
}

export type AbandonResult =
  | { ok: true }
  | { ok: false; refusal: { code: 'not_found'; message: string } }

/**
 * Clears a stale `sealPending`: the client died mid-transfer and the
 * destination never took the conversation. Admin-scoped at the wire layer —
 * this file has no scope opinion, it only performs the mutation.
 */
export function abandonPendingTransfer(args: AbandonArgs): AbandonResult {
  const state = readTabsState(args.paths.tabsFile)
  const found = findTab(state, args.tabId)
  if (!found) {
    log('refused: not_found', { tab_id: args.tabId, step: 'abandon', outcome: 'not_found' })
    return { ok: false, refusal: { code: 'not_found', message: `no tab ${args.tabId}` } }
  }
  state.tabs[found.index] = { ...found.tab, sealPending: undefined }
  writeTabsState(args.paths.tabsFile, state)
  log('pending transfer abandoned', { tab_id: args.tabId, step: 'abandon', outcome: 'ok' })
  return { ok: true }
}

export interface ReleaseArgs {
  tabId: string
  /** The `since` of the mark the caller's own export set. */
  sealedAt: number
  paths: TransferPaths
}

export type ReleaseResult =
  | { ok: true; released: boolean }
  | { ok: false; refusal: { code: 'not_found'; message: string } }

/**
 * Clears the mark ONE export set, when that export's archive never reached
 * the destination: the caller cancelled the download, or it failed. Matched
 * on `since`, so it can only undo the mark its own export wrote, never an
 * older one, a newer retry's, or one set for a move that did land. A mark
 * that no longer matches is left alone and reported as not released.
 */
export function releaseExportSeal(args: ReleaseArgs): ReleaseResult {
  const state = readTabsState(args.paths.tabsFile)
  const found = findTab(state, args.tabId)
  if (!found) {
    log('release refused: not_found', { tab_id: args.tabId, step: 'release', outcome: 'not_found' })
    return { ok: false, refusal: { code: 'not_found', message: `no tab ${args.tabId}` } }
  }
  const mark = found.tab.sealPending
  if (!mark || mark.since !== args.sealedAt) {
    log('release skipped: the mark is not the one this export set', { tab_id: args.tabId, step: 'release', outcome: 'mismatch', has_mark: !!mark, mark_since: mark?.since ?? 0, sealed_at: args.sealedAt })
    return { ok: true, released: false }
  }
  state.tabs[found.index] = { ...found.tab, sealPending: undefined }
  writeTabsState(args.paths.tabsFile, state)
  log('export mark released; nothing reached the destination', { tab_id: args.tabId, step: 'release', outcome: 'ok', target_environment_id: mark.targetEnvironmentId })
  return { ok: true, released: true }
}
