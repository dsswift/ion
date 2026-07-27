// ion-meta deterministic worktree-containment gate.
//
// Pure-function helper that decides whether a write-class tool call would write
// OUTSIDE the worktree a session is running in — into the base repo it was cut
// from, or into a sibling worktree of the same repo. Used by the `tool_call`
// hook wired in index.ts.
//
// Why a worktree must refuse writes into its base repo
// ---------------------------------------------------
// A worktree exists to isolate one conversation's work onto its own branch. When
// several worktree conversations write into the shared base checkout instead,
// three things go wrong at once and none of them is visible at the time:
//
//   - The conversations interleave. Each one's `git status` shows the others'
//     uncommitted files, and a `git add -A` sweeps up work that belongs to
//     someone else. This is not hypothetical: it is exactly what happened, and
//     one commit ended up carrying ~3,000 lines from an unrelated conversation.
//   - The isolation the operator asked for is silently absent. The UI says
//     "worktree", the branch is created, and the agent is writing somewhere else.
//   - Review cannot untangle it afterwards. The worktree is clean, the base repo
//     is dirty, and nothing records which conversation authored which hunk.
//
// Why a hook and not a persona rule
// ---------------------------------
// Same reasoning as git-gate.ts and bench-gate.ts: a persona-level "only write
// in your worktree" instruction is LLM compliance, and a model swap, prompt
// rephrase, or context compression erodes it. The engine-level `tool_call` hook
// returning `{ block: true, reason }` is a deterministic refusal the LLM cannot
// talk its way past.
//
// What is NOT guarded (the scope is deliberately narrow)
// -----------------------------------------------------
// This is NOT "confine the agent to its cwd". Writes to /tmp, ~/.ion, another
// repo entirely, or any unrelated directory all pass: agents legitimately need
// them, and over-blocking would make worktree conversations useless for real
// work. The rule is only:
//
//     cwd is a registered worktree of repo R
//         ⇒ deny writes into R's main checkout, and into R's OTHER worktrees.
//
// Sibling worktrees are included because sibling-to-sibling bleed is the same
// defect with a different destination, and the registry already has the data.
//
// When cwd is not a registered worktree the gate passes everything, so an
// ordinary repo conversation is completely unaffected.
//
// Honest limitation
// -----------------
// The predicate is "is my cwd a registered worktree". It therefore does NOT
// catch the original defect, where the session's cwd WAS the base repo (the gate
// concludes "not a worktree conversation" and passes). The fix for that is the
// desktop's create-order + reconciler work; this gate is the net for the next
// way a directory drifts, not a substitute for pointing sessions correctly.
//
// Why this duplicates the desktop's registry read
// -----------------------------------------------
// ion-meta ships as a standalone extension bundle and must not import from the
// desktop or the engine (see git-gate.ts — pure `node:` imports only). The
// desktop owns the same registry at desktop/src/main/worktree/inventory.ts. The
// shape is therefore read twice on purpose, and both sides carry tests.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { extractTargetPath } from './git-gate'

/**
 * Tool-call info shape the gate consumes. Mirrors the SDK's `ToolCallInfo`,
 * inlined so this module has no engine dependency.
 */
export interface ToolCallInfo {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}

/** Gate decision. `block: true` carries a user-facing reason. */
export interface WorktreeGateDecision {
  block: boolean
  /** The worktree the session is running in. */
  worktreePath?: string
  /** The forbidden path the call targeted. */
  targetPath?: string
  /** What the target belongs to, for the message. */
  targetKind?: 'base repo' | 'sibling worktree'
  reason?: string
}

/**
 * What a registered worktree tells us about its surroundings.
 */
export interface WorktreeContainment {
  /** The worktree the session cwd is inside. */
  worktreePath: string
  /** The main checkout this worktree was cut from. */
  repoPath: string
  /** Every OTHER registered worktree of the same repo. */
  siblingPaths: string[]
}

/**
 * Tools this gate applies to. Identical to git-gate's set, and for the same
 * reason: these are the calls that put bytes on disk. Read and dispatch tools
 * cannot violate worktree containment.
 *
 * `Bash` is gated on the session cwd rather than a parsed target, which is the
 * best deterministic signal available at gate time (see git-gate's
 * extractTargetPath). A `Bash` call whose cwd is the worktree therefore passes —
 * this gate cannot see a `cd` mid-command, and guessing would produce false
 * refusals in the operator's own working directory.
 */
const GATED_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'Bash',
  'ion_scaffold',
])

interface RegistryEntry {
  worktreePath: string
  repoPath: string
}

/** Cache of the parsed registry; see loadRegistry for the invalidation note. */
let registryCache: RegistryEntry[] | null = null

/** Test seam: drop the cache so a fixture registry is re-read. */
export function _resetWorktreeCacheForTests(): void {
  registryCache = null
}

/**
 * Decide whether `info` should be refused because it writes outside the
 * worktree the session is running in.
 *
 * Cheap checks first: an ungated tool and a non-worktree cwd both short-circuit
 * before the registry is consulted or any path is resolved.
 */
export function gateWorktreeWrite(info: ToolCallInfo, cwd: string): WorktreeGateDecision {
  if (!cwd) return { block: false }
  if (!GATED_TOOLS.has(info.toolName)) return { block: false }

  const containment = resolveWorktreeContainment(cwd)
  if (!containment) return { block: false }

  const target = extractTargetPath(info.toolName, info.input, cwd)
  if (!target) return { block: false }

  // Inside the session's own worktree: the normal, correct case.
  if (isWithin(target, containment.worktreePath)) return { block: false }

  // The base repo. Checked before siblings because a sibling worktree is NOT
  // physically inside the repo directory (Ion stores worktrees under
  // ~/.ion/worktrees), so the two cases cannot overlap — but naming the base
  // repo specifically makes the refusal clearer.
  if (isWithin(target, containment.repoPath)) {
    return {
      block: true,
      worktreePath: containment.worktreePath,
      targetPath: target,
      targetKind: 'base repo',
      reason: formatBlockReason(target, 'base repo', containment.worktreePath),
    }
  }

  for (const sibling of containment.siblingPaths) {
    if (isWithin(target, sibling)) {
      return {
        block: true,
        worktreePath: containment.worktreePath,
        targetPath: target,
        targetKind: 'sibling worktree',
        reason: formatBlockReason(target, 'sibling worktree', containment.worktreePath),
      }
    }
  }

  // Anywhere else — /tmp, ~/.ion, an unrelated repo. Not this gate's business.
  return { block: false }
}

/**
 * Resolve what `cwd` is contained by, or null when `cwd` is not inside any
 * registered worktree.
 *
 * Returning the full containment (rather than a boolean) is what lets the
 * refusal name the specific worktree the agent should be writing to, which is
 * what makes the message actionable rather than merely obstructive.
 */
export function resolveWorktreeContainment(cwd: string): WorktreeContainment | null {
  if (!cwd) return null

  const entries = loadRegistry()
  const own = entries.find((e) => isWithin(cwd, e.worktreePath))
  if (!own) return null

  const siblingPaths = entries
    .filter((e) => e.repoPath === own.repoPath && e.worktreePath !== own.worktreePath)
    .map((e) => e.worktreePath)

  return { worktreePath: own.worktreePath, repoPath: own.repoPath, siblingPaths }
}

/**
 * True when `path` is `root` or a descendant of it.
 *
 * The separator is REQUIRED on the descendant check. A bare
 * `path.startsWith(root)` would also match a sibling whose name merely begins
 * with the root — `…/ion-a33725460` against `…/ion-a3372546` — refusing writes
 * in an unrelated worktree. A false refusal in the place the operator is doing
 * real work is worse than the guard not firing, so the check is
 * exact-or-separator-prefixed, never bare. Same reasoning as
 * bench-guard.ts:resolveBenchFor.
 */
function isWithin(path: string, root: string): boolean {
  if (!path || !root) return false
  if (path === root) return true
  return path.startsWith(root + sep)
}

/**
 * Read the worktree registry the desktop maintains.
 *
 * Fails OPEN on every error: a missing file (no worktrees have ever been
 * created), malformed JSON, or an unreadable path all yield an empty list,
 * which makes the gate pass everything. Refusing writes because a registry
 * could not be parsed would block legitimate work in an ordinary directory,
 * which is a worse failure than briefly missing the guard — the same fail-open
 * posture bench-guard.ts documents.
 *
 * Cached for the life of the extension host. A worktree created mid-session is
 * therefore not immediately visible to the gate; that direction is safe (it can
 * only under-block, never falsely refuse), and the host is short-lived enough
 * that a stale entry does not outlive the operator's attention.
 */
function loadRegistry(): RegistryEntry[] {
  if (registryCache !== null) return registryCache

  const file = join(homedir(), '.ion', 'worktree-registry.json')
  if (!existsSync(file)) {
    registryCache = []
    return registryCache
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    const entries = (parsed as { entries?: unknown })?.entries
    if (!Array.isArray(entries)) {
      registryCache = []
      return registryCache
    }
    registryCache = entries
      .filter((e): e is RegistryEntry =>
        !!e
        && typeof (e as RegistryEntry).worktreePath === 'string'
        && typeof (e as RegistryEntry).repoPath === 'string'
        && (e as RegistryEntry).worktreePath !== ''
        && (e as RegistryEntry).repoPath !== '')
      .map((e) => ({ worktreePath: e.worktreePath, repoPath: e.repoPath }))
    return registryCache
  } catch {
    // silent-ok: an unreadable or malformed registry fails open by design (see
    // the doc comment above). The caller logs the pass decision, so the gate's
    // behaviour is still observable.
    registryCache = []
    return registryCache
  }
}

/**
 * Build the refusal message.
 *
 * It names the offending path, what that path belongs to, and the worktree the
 * agent should write to instead — a refusal the model can act on rather than
 * merely retry.
 */
function formatBlockReason(
  target: string,
  kind: 'base repo' | 'sibling worktree',
  worktreePath: string,
): string {
  const owner = kind === 'base repo'
    ? 'the base repository this worktree was cut from'
    : 'a different worktree belonging to another conversation'
  return [
    `Refused: ${target} is inside ${owner}.`,
    `This conversation is working in ${worktreePath} and must write only there —`,
    'writing into the shared checkout interleaves this work with other',
    'conversations, and neither side can be reviewed or reverted cleanly',
    'afterwards.',
    `Write to the equivalent path under ${worktreePath} instead.`,
    'If the change genuinely belongs to another branch, land this worktree',
    'first and make the change in a conversation that owns that directory.',
  ].join(' ')
}
