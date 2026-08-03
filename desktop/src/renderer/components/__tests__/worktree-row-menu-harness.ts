// Shared fixtures for the WorktreeRowMenu test files.
//
// The menu's suites are split by concern — retire flow in
// `WorktreeRowMenuRetire.test.tsx`, click-dismissal in
// `WorktreeRowMenuDismissal.test.tsx` — but they drive the same component
// through the same gestures. These helpers are the part that is genuinely
// common: the entry fixture, the appraisal fixtures, and the pointer gestures.
//
// The `vi.mock` factories and the hoisted mock object deliberately stay in each
// test file. Vitest module mocking is per-file and hoisted above imports, so a
// shared version would not apply to the importing suite.
import { act } from 'react'
import type { WorktreeAppraisalWire, WorktreeInventoryEntry } from '../../../shared/types'

export const WT = '/Users/dev/.ion/worktrees/ion-a3f1'
export const REPO = '/Users/dev/src/ion'
export const BRANCH = 'wt/ion-a3f1'

/**
 * A worktree row. Defaults to DIRTY with nothing unlanded, which is the state
 * that gates Sync and Land off and sends Retire down the "may still hold work"
 * arm — the arms most tests want. Override per test.
 */
export function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT,
    branchName: BRANCH,
    label: 'ion-a3f1',
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'fix token expiry',
    isDirty: true,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

/**
 * Appraisal fixtures, typed against the real wire shape so they cannot drift
 * from it. A partial stand-in is not safe here: the menu reads the path and
 * commit counts when it logs, so a two-field mock makes the component throw in
 * a way production never would.
 *
 * Every field of `WorktreeAppraisalWire` is spelled out, including the ones no
 * test asserts on. The annotation is what does the work: it makes drift in
 * EITHER direction a `tsc` failure — a field added to the wire is missing here,
 * and a field removed from the wire is still set here. Neither shows up in the
 * suite, because vitest does not typecheck, so `npm run typecheck` is the gate
 * that catches it.
 */
export const DIRTY_APPRAISAL: WorktreeAppraisalWire = {
  hasUncommittedChanges: true,
  uncommittedPaths: ['src/a.ts'],
  unlandedCommitCount: 0,
  fullyLanded: false,
  safeToDiscard: false,
  reason: 'It holds 1 uncommitted file.',
}

export const CLEAN_APPRAISAL: WorktreeAppraisalWire = {
  hasUncommittedChanges: false,
  uncommittedPaths: [],
  unlandedCommitCount: 0,
  fullyLanded: true,
  safeToDiscard: true,
}

/** Find a button by its exact trimmed label, naming what was on screen if absent. */
export function findButton(label: string): HTMLElement {
  const all = [...document.querySelectorAll('button')]
  const match = all.find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`no button labelled "${label}"; saw: ${all.map((b) => b.textContent).join(' | ')}`)
  return match as HTMLElement
}

/**
 * Press a button the way a real pointer does: mousedown, then click.
 *
 * The mousedown is the whole point — it is what the menu's dismissal handler
 * sees, and dispatching only `click` would pass even with the dismissal bug
 * present.
 */
export async function press(label: string): Promise<void> {
  const button = findButton(label)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
