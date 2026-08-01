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
 * A bench is a REASSEMBLABLE worktree: its branch is recreated from the source
 * branch plus each member's pinned commit on every assembly. Two consequences
 * drive the UI:
 *
 *   - It must never have uncommitted changes. Anything edited there is
 *     destroyed by the next `switch -C … --discard-changes`, so presenting a
 *     Changes section invites exactly the edit that will be lost.
 *   - Its history is synthetic — one merge commit per member, recreated every
 *     assembly — so a commit graph of it tells the operator nothing real.
 *
 * Both sections are therefore hidden in a bench, and the panel says which bench
 * you are in instead.
 */
import type { IntegrationWorkspace, IntegrationMember } from '../../../shared/types'

/**
 * Path separators, checked without importing Node's `path`.
 *
 * This module runs in the RENDERER, which Vite bundles for the browser — a
 * `import { sep } from 'path'` resolves to `__vite-browser-external` and fails
 * the production build outright (it type-checks and unit-tests fine, because
 * both of those run under Node, which is how it slipped through).
 *
 * Both separators are accepted rather than the current platform's: the paths
 * being compared come from the main process and from persisted state, so a
 * Windows path can legitimately reach a renderer that has no `path` module to
 * ask about it.
 */
const SEPARATORS = ['/', '\\'] as const

/** True when `path` is `root` itself or a descendant directory of it. */
function isWithin(path: string, root: string): boolean {
  if (path === root) return true
  return SEPARATORS.some((s) => path.startsWith(root + s))
}

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
 * Resolve which bench contains `directory`, searching EVERY repo's workspaces.
 *
 * A bench conversation's tab carries no `worktree` metadata (a bench is
 * deliberately not enrolled as a member of itself), so the panel cannot resolve
 * its owning repo from the tab and falls back to the bench directory. Looking
 * the workspaces up by that path finds nothing -- `benchWorkspaces` is keyed by
 * REPO -- so the panel concluded it was not in a bench at all, showed the Graph
 * section a bench must hide, and listed the bench's own raw `git worktree list`
 * (main clone included, no registry, no memberships).
 *
 * Searching all loaded repos is what makes the bench self-identifying: the
 * answer no longer depends on already knowing which repo to ask about.
 */
export function resolveBenchContextAcrossRepos(
  directory: string,
  byRepo: ReadonlyMap<string, IntegrationWorkspace[]>,
): BenchContext | null {
  if (!directory) return null
  for (const workspaces of byRepo.values()) {
    const hit = resolveBenchContext(directory, workspaces)
    if (hit) return hit
  }
  return null
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
    if (!isWithin(directory, ws.benchPath)) continue
    return {
      benchPath: ws.benchPath,
      sourceBranch: ws.sourceBranch,
      repoPath: ws.repoPath,
      members: ws.members ?? [],
    }
  }
  return null
}
