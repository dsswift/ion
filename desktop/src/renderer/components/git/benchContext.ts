/**
 * Is this directory an integration bench, and if so, whose?
 *
 * ── Why the renderer needs its own answer ───────────────────────────────────
 * The main process already knows (`main/integration/bench-guard.ts`), but that
 * module is Electron-bound and the renderer cannot import it. The renderer does
 * however already hold everything required: `benchWorkspaces` carries each
 * workspace's `benchPath` and its member list. So this is a pure derivation
 * over state the store has, not a new IPC round-trip — which also means the
 * answer is available on the first render rather than after a fetch.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * A bench is a REBUILDABLE worktree: its branch is recreated from the source
 * branch plus each member's pinned commit on every rebuild. Two consequences
 * drive the UI:
 *
 *   - It must never have uncommitted changes. Anything edited there is
 *     destroyed by the next `switch -C … --discard-changes`, so presenting a
 *     Changes section invites exactly the edit that will be lost.
 *   - Its history is synthetic — one merge commit per member, recreated every
 *     rebuild — so a commit graph of it tells the operator nothing real.
 *
 * Both sections are therefore hidden in a bench, and the panel says which bench
 * you are in instead.
 */
import { sep } from 'path'
import type { IntegrationWorkspace, IntegrationMember } from '../../../shared/types'

export interface BenchContext {
  /** The bench directory this path is inside. */
  benchPath: string
  /** The branch the bench integrates into. */
  sourceBranch: string
  /** The repo the bench belongs to. */
  repoPath: string
  /** Members currently layered onto the bench. */
  members: IntegrationMember[]
}

/**
 * Resolve which bench contains `directory`, or null when none does.
 *
 * Containment is exact-or-separator-prefixed, never a bare `startsWith`. A bare
 * prefix test would also match a sibling whose name merely begins with the
 * bench path — `…/ion-josh-other` against `…/ion-josh` — and would strip the
 * Changes section from an unrelated worktree where the operator is doing real
 * work. Same reasoning, and the same failure, as `bench-guard.ts:resolveBenchFor`.
 *
 * `workspaces` may be undefined (no bench has ever been created for this repo),
 * which is the common case and returns null.
 */
export function resolveBenchContext(
  directory: string,
  workspaces: IntegrationWorkspace[] | undefined,
): BenchContext | null {
  if (!directory || !workspaces?.length) return null

  for (const ws of workspaces) {
    if (!ws.benchPath) continue
    const isBench = directory === ws.benchPath || directory.startsWith(ws.benchPath + sep)
    if (!isBench) continue
    return {
      benchPath: ws.benchPath,
      sourceBranch: ws.sourceBranch,
      repoPath: ws.repoPath,
      members: ws.members ?? [],
    }
  }
  return null
}
