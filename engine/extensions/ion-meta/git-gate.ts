// ion-meta deterministic write-gate.
//
// Pure-function helper that decides whether a tool call (Write / Edit /
// Bash / ion_scaffold) targets a path inside a git working tree. Used by
// the `tool_call` hook wired in index.ts to refuse write-class tools
// outside a repo.
//
// Why this is a hook and not a persona rule
// -----------------------------------------
// Persona-level "don't write outside the target dir" rules are LLM
// compliance. Strong, but not deterministic — a model swap, a prompt
// rephrase, or a context compression can erode them. The engine-level
// `tool_call` hook with `{ block: true, reason }` is a deterministic
// refusal the LLM cannot bypass.
//
// Reversibility is the value being protected. If the user pointed the
// improver at /tmp/scratch.ts and the harness happily edited it, the
// user has no `git diff` to review and no `git checkout` to back out.
// By requiring the target be inside a git working tree, every edit is
// auditable and revertible without ion-meta needing to maintain its
// own backup/journal machinery (forbidden per the no-state rule).
//
// See docs/architecture/adr/006-deterministic-seams-and-probabilistic-judgment.md
// for the design framing.

import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Tool-call info shape the gate consumes. Mirrors the SDK's `ToolCallInfo`
 * but inlined here so the module has no engine dependency (it's pure
 * Node fs/path; trivially unit-testable).
 */
export interface ToolCallInfo {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}

/**
 * Gate decision. `block: false` means the call passes; `block: true`
 * carries the resolved path and a user-facing reason string.
 */
export interface GateDecision {
  block: boolean
  path?: string
  reason?: string
}

/**
 * Set of tool names the gate applies to. Read-only / dispatch tools
 * (`Read`, `Grep`, `Glob`, `Agent`, every `ion_list_*` / `ion_read_doc` /
 * `ion_inspect_extension` / `ion_validate_*` / `ion_typecheck_extension`)
 * are not gated — they cannot modify the filesystem outside an extension's
 * own working area.
 *
 * `ion_scaffold` IS gated when invoked with `targetDir` because it writes
 * the new extension layout to disk.
 */
const GATED_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'Bash',
  'ion_scaffold',
])

/**
 * Main entry point. Decides whether the tool call should be blocked.
 *
 * Algorithm:
 *   1. If the tool isn't in GATED_TOOLS → allow (no decision needed).
 *   2. Extract the target path off the input via tool-specific shape.
 *      If the tool has no extractable target → allow (no path to gate).
 *   3. Resolve the path against sessionCwd if it's relative.
 *   4. Walk up looking for `.git/` (directory) or `.git` (file pointer
 *      for git worktrees). If found at any ancestor → allow.
 *   5. Otherwise → block, with a reason explaining why and offering
 *      three remediation options.
 *
 * The walk stops at the filesystem root and at `~` (the user's home
 * directory). We intentionally do NOT escape `~` looking for a parent
 * repo — the user's broader filesystem is not a sane fallback. If they
 * want ion-meta to edit there, they `git init` it.
 */
export function gateWriteToolCall(info: ToolCallInfo, sessionCwd: string): GateDecision {
  if (!GATED_TOOLS.has(info.toolName)) {
    return { block: false }
  }
  const target = extractTargetPath(info.toolName, info.input, sessionCwd)
  if (!target) {
    // Tool is gated in principle but has no extractable target path
    // (e.g. a `Bash` call with no cwd anywhere — shouldn't happen, but
    // fail open rather than blocking blindly).
    return { block: false }
  }
  if (isInsideGitWorkingTree(target)) {
    return { block: false }
  }
  return {
    block: true,
    path: target,
    reason: formatBlockReason(info.toolName, target),
  }
}

/**
 * Extract the path-of-interest from the tool input. Returns an absolute
 * path or undefined when the tool has no relevant path.
 *
 * Tool-specific shapes (matches the SDK / Anthropic tool conventions):
 *   - Write / Edit → `input.file_path`
 *   - Bash → `sessionCwd`. This gate only asks "is the target inside ANY git
 *     working tree", and a `cd` elsewhere in the command almost always lands in
 *     one too, so the cwd is a sufficient signal here. Callers that need to know
 *     WHICH tree a command operates in (worktree-gate.ts) resolve the command
 *     text via bash-destination.ts instead.
 *   - ion_scaffold → `input.targetDir` (when provided). When `targetDir`
 *     doesn't exist yet, we gate the *parent* — because the target dir
 *     is the thing being created, the question is whether its parent
 *     is in a repo.
 */
export function extractTargetPath(
  toolName: string,
  input: Record<string, unknown>,
  sessionCwd: string,
): string | undefined {
  switch (toolName) {
    case 'Write':
    case 'Edit': {
      const filePath = input.file_path
      if (typeof filePath !== 'string' || filePath === '') return undefined
      return absolutise(filePath, sessionCwd)
    }
    case 'Bash': {
      if (!sessionCwd) return undefined
      return absolutise(sessionCwd, sessionCwd)
    }
    case 'ion_scaffold': {
      const targetDir = input.targetDir
      if (typeof targetDir !== 'string' || targetDir === '') {
        // ion_scaffold with no targetDir runs in preview mode (returns
        // templates inline; does not write to disk). Not gated.
        return undefined
      }
      const abs = absolutise(targetDir, sessionCwd)
      // If the target dir already exists, gate it directly. If it does
      // not exist yet (the scaffold is creating it), gate the parent —
      // the question is whether the *parent* is in a repo, because that's
      // where the new files will land.
      if (existsSync(abs)) return abs
      return dirname(abs)
    }
    default:
      return undefined
  }
}

function absolutise(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base || process.cwd(), p)
}

/**
 * Walk up from `path` looking for `.git/` or `.git` at any ancestor.
 * Returns true if found (path is inside a git working tree), false
 * otherwise. Stops at the filesystem root or at the user's home dir,
 * whichever comes first — we do not escape `~` looking for a parent
 * repo.
 *
 * Cached per resolved-ancestor: once a directory resolves to "inside a
 * repo" or "not inside a repo," sibling/descendant lookups within the
 * same session reuse the result.
 */
export function isInsideGitWorkingTree(path: string): boolean {
  if (!path) return false
  let current = path
  const home = homedir()
  const visited: string[] = []

  // Cache check: if any ancestor is already classified, we're done.
  while (true) {
    const cached = repoCache.get(current)
    if (cached !== undefined) {
      // Backfill cache for every directory we visited on the way here,
      // so the next call short-circuits earlier.
      for (const v of visited) repoCache.set(v, cached)
      return cached
    }
    visited.push(current)
    if (hasGitMarker(current)) {
      for (const v of visited) repoCache.set(v, true)
      return true
    }
    // Stop conditions: filesystem root, the user's home directory, or
    // an unreachable parent. We treat reaching `~` as "no repo" because
    // a generic `.git` inside `~` (rare but possible) would otherwise
    // make every file in the user's home "in a repo", which is not the
    // semantic we want.
    const parent = dirname(current)
    if (parent === current) {
      // Filesystem root.
      for (const v of visited) repoCache.set(v, false)
      return false
    }
    if (current === home) {
      // Reached `~` without finding a `.git` along the way. Stop.
      for (const v of visited) repoCache.set(v, false)
      return false
    }
    current = parent
  }
}

/**
 * Cache of directory-path -> "is inside a git working tree?".
 *
 * Lifetime is the process lifetime (the extension subprocess). The cache
 * is purely an optimisation; correctness does not depend on it. A user
 * who `git init`s a directory mid-session and then asks for an edit will
 * still see the gate refuse (we cached the negative answer). The cache
 * is invalidated automatically on extension subprocess restart, which is
 * the natural seam for `git init`-then-retry flows. If this becomes a
 * pain point we can add a TTL.
 */
const repoCache = new Map<string, boolean>()

/**
 * Reset the repo cache. Exported for tests; not used in production code.
 */
export function _resetRepoCacheForTests(): void {
  repoCache.clear()
}

function hasGitMarker(dir: string): boolean {
  // A `.git` directory is the common case (a normal working tree).
  // A `.git` *file* is used by worktrees (`git worktree add`); the file
  // contains a `gitdir:` pointer to the real git dir. Either signals
  // "this is the root of a working tree."
  const gitPath = resolve(dir, '.git')
  if (!existsSync(gitPath)) return false
  try {
    const st = statSync(gitPath)
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/**
 * Build the LLM-readable refusal message. The block reason flows back to
 * the LLM as the tool-call result; the persona's "what to do when blocked"
 * prose tells the agent to surface this verbatim to the user and offer
 * the three remediations.
 */
export function formatBlockReason(toolName: string, path: string): string {
  return [
    `ion-meta refused this ${toolName} call because \`${path}\` is not inside a git working tree.`,
    'ion-meta only edits files under version control so changes are reviewable and revertible.',
    'To proceed: (1) move the target into an existing git repo, (2) run `git init` in the target directory or one of its ancestors, or (3) ask me to teach or explain instead of edit.',
  ].join(' ')
}
