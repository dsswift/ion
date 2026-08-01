/**
 * repo-containment — "does this directory belong to that repository?"
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * The answer is one line, and getting it wrong is quiet. The conflict banner
 * asked it with `dir.includes(repoPath)` — a substring match on an absolute
 * path — so a project at `/src/ion` claimed conflicts belonging to
 * `/src/ion-other` and raised a banner for an unrelated repository.
 *
 * The correct rule already existed three times in the tree (`isWithin` in
 * ion-meta's worktree-gate.ts, `resolveBenchFor` in bench-guard.ts, the
 * realpath checks in theme-packs.ts), each with a comment explaining that a
 * bare prefix test matches `ion-a33725460` against `ion-a3372546`. This is that
 * rule in `shared/`, where a renderer component and a main-process module can
 * both reach it, so the fourth caller does not have to rediscover it.
 *
 * Pure string logic: no `node:path` import, no Electron, no theme. That is
 * deliberate — the predicate lives here rather than inside the component that
 * needed it because a component drags the theme (and therefore `document`) into
 * any test that wants to check one boolean.
 */

/**
 * True when `dir` is `root` itself or a path beneath it.
 *
 * The separator on the descendant check is the whole point: without it a
 * sibling whose name merely begins with the root matches. Both arguments must
 * be absolute paths in the same normalised form — this compares strings and
 * resolves nothing, because every caller already holds resolved paths from git
 * or from the worktree registry.
 *
 * Empty inputs are false rather than universally true: "no directory" is not a
 * place, and a permissive answer here would attribute every alert to a repo
 * whose path had not loaded yet.
 */
export function isWithinRepo(dir: string, root: string): boolean {
  if (!dir || !root) return false
  return dir === root || dir.startsWith(root + '/')
}
