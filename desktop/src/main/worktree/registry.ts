/**
 * Worktree registry — the durable record of every worktree Ion manages.
 *
 * Extracted from inventory.ts at the record/crawl seam to keep both files
 * under the 600-line cap: this module owns the persisted registry entries
 * (source branch, base, title, stage, landedAt) and every read/write of them;
 * inventory.ts owns the live git crawl that joins these records onto what
 * `git worktree list` reports. inventory.ts re-exports everything here, so
 * existing import paths keep working.
 *
 * ── Source-branch resolution (why this file exists) ─────────────────────────
 * Every lifecycle verb (land, sync, base staleness) needs to know which branch a
 * worktree was cut FROM, and git does not record that. A worktree created by
 * Ion registers itself here, so the answer is durable and exact.
 *
 * When a worktree has no registry entry — created before this existed, or by
 * hand on the command line — the source branch is REPORTED AS UNKNOWN rather
 * than guessed. A wrong source branch would make "land" merge into the wrong
 * place, which is far worse than asking. Callers surface a picker instead.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'
import { invalidateWorktreeInventoryCache } from './inventory-cache'
import { workStageDescriptor, type WorkStage } from '../../shared/types-git'

const TAG = 'worktree.registry'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type RegistryWriter = (path: string, data: string) => void

let _writer: RegistryWriter = (path, data) => atomicWriteFileSync(path, data, 0o644)

export function setRegistryWriter(w: RegistryWriter): void { _writer = w }
export function resetRegistryWriter(): void { _writer = (p, d) => atomicWriteFileSync(p, d, 0o644) }

// Resolved lazily, not captured at module load: a frozen path is unobservable
// and would make a test that redirects HOME write to the real ~/.ion.
function ionDir(): string { return join(homedir(), '.ion') }
export function worktreeRegistryFile(): string { return join(ionDir(), 'worktree-registry.json') }

interface RegistryEntry {
  worktreePath: string
  repoPath: string
  branchName: string
  /**
   * The branch this worktree was cut from — not recoverable from git.
   *
   * Null for a worktree Ion knows about but did not cut (a hand-created one
   * that has since been given a title, see `setWorktreeTitle`). Recording a
   * title must never require inventing a source branch: a wrong one would make
   * `land` merge into the wrong place, which is exactly what the unknown-source
   * path exists to prevent.
   */
  sourceBranch: string | null
  /**
   * The source-branch commit this worktree is currently based on — written at
   * creation and advanced after every successful sync.
   *
   * ── Why this is STORED and not derived ──────────────────────────────────
   * The obvious derivation, `git merge-base <branch> <sourceBranch>`, breaks
   * the moment the source branch is REBASED (e.g. the feature branch is
   * rebased onto main after a PR lands): the old base commits are no longer on
   * the source branch, the merge base falls back to some deep common ancestor,
   * and a plain `git rebase <sourceBranch>` then replays STALE COPIES of
   * upstream commits — not just the worktree's own work — manufacturing
   * conflicts out of content the worktree never touched. This is the same
   * cannot-recover-after-the-fact trap as `landedAt` below and the bench's
   * `pinnedBaseSha`: the fact must be captured at the moment it is knowable.
   *
   * With the base stored, sync runs `git rebase --onto <source> <baseSha>`,
   * which replays exactly the worktree's own commits. Absent on entries
   * written before this existed — sync falls back to the plain rebase and
   * backfills on its first success. Absent means "unknown", never a guess.
   */
  baseSha?: string
  /**
   * Human-readable description of what this worktree is FOR.
   *
   * Seeded from the conversation that started the worktree: either the name it
   * already had when it was converted into one, or the title generated for its
   * first real prompt (see the seed IPC). Written ONCE — later conversations
   * opened in the same worktree never change it, because a worktree's topic is
   * set by the work it was cut for. The operator can override it explicitly.
   *
   * Absent until then. Every other identifier a worktree has — `ion-03e81090`,
   * `wt/ion-03e81090`, a commit sha — is a machine string that tells the
   * operator nothing about the work, which is what this field fixes.
   */
  title?: string
  createdAt: number
  /**
   * When this worktree's commits were landed into its source branch.
   *
   * ── Why this is STORED and not derived ──────────────────────────────────
   * "Has landed" cannot be answered by any git query after the fact. A worktree
   * that never committed anything and one whose work landed both end up clean,
   * with zero commits in `sourceBranch..branch`, and a tip equal to their merge
   * base with the source. Fork-point, ancestry and merge-base probes all
   * collapse to the same answer for both.
   *
   * This is the same trap `IntegrationMember.pinnedBaseSha` documents for bench
   * members, where the bench once read "never started" as "landed" and deleted
   * the member. The fix there was also a stored fact captured at the moment it
   * was still knowable.
   *
   * The land verb is the only code that witnesses the transition, so it is the
   * only place this is written. Absent means NOT landed -- never "unknown, guess"
   * -- which is what keeps a freshly created empty worktree out of the landed
   * band. A worktree landed before this field existed reads as active until it
   * is retired; that degrades honestly, where inferring would not.
   */
  landedAt?: number
  /**
   * The operator's workflow stage for this worktree, or absent when none has
   * been set. The vocabulary and its one automatic transition (`bug` → `test`
   * on a bench pin advance) live in shared/types-git.ts (`WORK_STAGES`).
   *
   * Registry-scoped rather than bench-scoped on purpose: `plan` happens before
   * any enrollment exists, and the stage describes the worktree's lifecycle —
   * so it must survive enrollment, disenrollment, and pin advances, which a
   * field on the bench member record could not.
   */
  stage?: WorkStage
}

interface RegistryFile {
  version: 1
  entries: RegistryEntry[]
}

function loadRegistry(): RegistryEntry[] {
  const file = worktreeRegistryFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<RegistryFile>
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((e): e is RegistryEntry =>
        // sourceBranch may legitimately be null: a hand-created worktree that
        // has been titled is registered with an unknown source rather than a
        // guessed one. Requiring a string here would silently drop those
        // entries on the next read, losing the title.
        !!e && typeof e.worktreePath === 'string'
        && (typeof e.sourceBranch === 'string' || e.sourceBranch === null))
      : []
  } catch (err) {
    warn('registry unreadable, treating as empty', { path: file, error: String(err) })
    return []
  }
}

function saveRegistry(entries: RegistryEntry[]): boolean {
  try {
    const dir = ionDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: RegistryFile = { version: 1, entries }
    _writer(worktreeRegistryFile(), JSON.stringify(payload, null, 2))
    return true
  } catch (err) {
    warn('failed to save worktree registry', { path: worktreeRegistryFile(), error: String(err) })
    return false
  }
}

/**
 * Record a worktree's source branch. Called from every path that creates a
 * worktree, so the lifecycle verbs always know where it lands.
 *
 * An existing TITLE survives re-registration, and always wins over the `title`
 * argument. Re-registering happens when a worktree is re-attached at the same
 * path, and the description of what the work is about is still true — dropping
 * it would silently un-name the row.
 *
 * `title` is the SEED: the name of the conversation this worktree was cut for,
 * passed by the creation paths that already have one (converting a named
 * conversation into a worktree, re-attaching a live one). A worktree cut before
 * its conversation has any name — the panel's "New worktree" button, a fresh
 * tab — passes nothing and is named later by its first prompt. Because a
 * stored title always wins, a seed can never overwrite a name the worktree
 * already carries.
 */
export function registerWorktree(args: {
  worktreePath: string
  repoPath: string
  branchName: string
  sourceBranch: string
  title?: string
  /**
   * The source-branch tip the worktree was cut from, resolved by the creation
   * path (which is the only code positioned to know it). Optional so callers
   * that genuinely cannot resolve it register without one — sync then uses the
   * plain-rebase fallback and backfills on its first success.
   */
  baseSha?: string
}): boolean {
  const previous = loadRegistry().find((e) => e.worktreePath === args.worktreePath)
  const entries = loadRegistry().filter((e) => e.worktreePath !== args.worktreePath)
  const seeded = args.title?.trim() || undefined
  // `landedAt` and `stage` are carried across a re-registration: the same
  // directory being re-registered has not un-landed its history, and the
  // operator's workflow marker is still where they left it. `baseSha` prefers
  // the fresh value (a re-attach cut a NEW checkout from the current tip) and
  // falls back to the previous record.
  entries.push({
    worktreePath: args.worktreePath,
    repoPath: args.repoPath,
    branchName: args.branchName,
    sourceBranch: args.sourceBranch,
    baseSha: args.baseSha ?? previous?.baseSha,
    title: previous?.title ?? seeded,
    landedAt: previous?.landedAt,
    stage: previous?.stage,
    createdAt: Date.now(),
  })
  const saved = saveRegistry(entries)
  if (saved) {
    invalidateWorktreeInventoryCache('worktree registered')
    log('registered worktree', {
      worktree_path: args.worktreePath,
      branch: args.branchName,
      source_branch: args.sourceBranch,
      base_sha: (args.baseSha ?? previous?.baseSha ?? '').slice(0, 7),
      retained_title: previous?.title ?? '',
      seeded_title: previous?.title ? '' : (seeded ?? ''),
    })
  }
  return saved
}

/**
 * Record that a worktree's commits reached its source branch.
 *
 * Called only from the land path, which is the only code that can witness the
 * transition -- see the `landedAt` field comment for why it cannot be derived
 * afterwards. Idempotent: landing twice keeps the FIRST timestamp, because that
 * is when the work actually arrived.
 *
 * A worktree with no registry entry is not created here. Landing one implies it
 * was registered, and inventing an entry with a fabricated `sourceBranch` is the
 * failure mode the registry's null-source rule exists to prevent.
 */
export function markWorktreeLanded(worktreePath: string): boolean {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (!existing) {
    warn('cannot mark landed, no registry entry', { worktree_path: worktreePath })
    return false
  }
  if (existing.landedAt) {
    log('worktree already marked landed', {
      worktree_path: worktreePath, landed_at: existing.landedAt,
    })
    return true
  }
  existing.landedAt = Date.now()
  const saved = saveRegistry(entries)
  if (saved) {
    invalidateWorktreeInventoryCache('worktree landed')
    log('worktree marked landed', { worktree_path: worktreePath, landed_at: existing.landedAt })
  }
  return saved
}

/**
 * Give a worktree a human-readable title, creating a registry entry when one
 * does not exist yet.
 *
 * The upsert matters: a worktree created by hand on the command line has no
 * registry entry, but it still shows up in the inventory and still deserves a
 * name. Such an entry records `sourceBranch: null` — Ion genuinely does not
 * know what it was cut from, and the lifecycle verbs must keep asking rather
 * than acting on a fabricated answer.
 *
 * `repoPath` and `branchName` are optional because a titling caller may not
 * know them; they are only filled in when creating a new entry, never used to
 * overwrite what an existing registration already recorded.
 */
export function setWorktreeTitle(
  worktreePath: string,
  title: string,
  fallback?: { repoPath?: string; branchName?: string },
): boolean {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (existing) {
    const previous = existing.title
    existing.title = title
    const saved = saveRegistry(entries)
    if (saved) {
      invalidateWorktreeInventoryCache('worktree titled')
      log('worktree title set', { worktree_path: worktreePath, title, replaced: previous ?? '' })
    }
    return saved
  }

  entries.push({
    worktreePath,
    repoPath: fallback?.repoPath ?? '',
    branchName: fallback?.branchName ?? '',
    // Unknown, and deliberately not guessed. See the field comment.
    sourceBranch: null,
    title,
    createdAt: Date.now(),
  })
  const saved = saveRegistry(entries)
  if (saved) {
    invalidateWorktreeInventoryCache('worktree titled')
    log('worktree title set on a new registry entry', {
      worktree_path: worktreePath,
      title,
      repo_path: fallback?.repoPath ?? '',
      source_branch: 'unknown',
    })
  }
  return saved
}

/** A worktree's recorded title, or null when it has never been named. */
export function lookupWorktreeTitle(worktreePath: string): string | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.title ?? null
}

/**
 * Set or clear a worktree's workflow stage, creating a registry entry when one
 * does not exist yet (same upsert rationale as `setWorktreeTitle`: a
 * hand-created worktree still deserves a marker, and the new entry records
 * `sourceBranch: null` rather than a guess).
 *
 * `null` clears the stage — selecting the active stage in a picker un-sets it,
 * so no marker is sticky once the operator revisits the evidence.
 */
export function setWorktreeStage(
  worktreePath: string,
  stage: WorkStage | null,
  fallback?: { repoPath?: string; branchName?: string },
): boolean {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (existing) {
    const previous = existing.stage
    existing.stage = stage ?? undefined
    const saved = saveRegistry(entries)
    if (saved) {
      invalidateWorktreeInventoryCache('worktree stage set')
      log('worktree stage set', {
        worktree_path: worktreePath,
        stage: stage ?? 'none',
        replaced: previous ?? 'none',
      })
    }
    return saved
  }

  if (!stage) {
    log('stage clear skipped: no registry entry', { worktree_path: worktreePath })
    return true
  }

  entries.push({
    worktreePath,
    repoPath: fallback?.repoPath ?? '',
    branchName: fallback?.branchName ?? '',
    // Unknown, and deliberately not guessed. See the sourceBranch field comment.
    sourceBranch: null,
    stage,
    createdAt: Date.now(),
  })
  const saved = saveRegistry(entries)
  if (saved) {
    invalidateWorktreeInventoryCache('worktree stage set')
    log('worktree stage set on a new registry entry', {
      worktree_path: worktreePath,
      stage,
      repo_path: fallback?.repoPath ?? '',
      source_branch: 'unknown',
    })
  }
  return saved
}

/**
 * Apply the stage vocabulary's automatic pin-advance transition: a worktree
 * marked `bug` moves to `test` when new content of its own reaches the bench.
 *
 * Called from the bench's two pin-advance sites (updateMember / updateAllStale
 * in integration/bench-ops.ts), and only when the pin ACTUALLY moved —
 * re-pinning identical content keeps the flag, because the bug is still in
 * there. The transition is data-driven off `WORK_STAGES[].onPinAdvance`, so a
 * future stage with its own advance behaviour needs no new call site.
 *
 * A worktree with no registry entry, no stage, or a stage with no advance rule
 * is a logged no-op.
 */
export function advanceWorktreeStageOnPinChange(worktreePath: string): boolean {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (!existing?.stage) return true
  const next = workStageDescriptor(existing.stage)?.onPinAdvance
  if (!next) return true
  const previous = existing.stage
  existing.stage = next
  const saved = saveRegistry(entries)
  if (saved) {
    invalidateWorktreeInventoryCache('worktree stage auto-advanced')
    log('worktree stage auto-advanced on pin change', {
      worktree_path: worktreePath,
      from: previous,
      to: next,
    })
  }
  return saved
}

/** A worktree's recorded workflow stage, or null when none is set. */
export function lookupWorktreeStage(worktreePath: string): WorkStage | null {
  const raw = loadRegistry().find((e) => e.worktreePath === worktreePath)?.stage
  // Filtered through the descriptor table so a hand-edited or future-version
  // value degrades to "no stage" instead of leaking an unknown string to
  // every renderer.
  return workStageDescriptor(raw)?.id ?? null
}

/** When this worktree's work landed, or null when it has not (or Ion has no record). */
export function lookupWorktreeLandedAt(worktreePath: string): number | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.landedAt ?? null
}

/**
 * The full registration for a worktree, or null when Ion has no record.
 *
 * Callers that must decide "is this directory a worktree Ion manages, and which
 * repo does it belong to" read this rather than inferring from the path shape —
 * a path can look like a worktree without being one.
 */
export function lookupWorktreeRegistration(worktreePath: string): {
  repoPath: string
  branchName: string
  sourceBranch: string | null
  title: string | null
} | null {
  const entry = loadRegistry().find((e) => e.worktreePath === worktreePath)
  if (!entry) return null
  return {
    repoPath: entry.repoPath,
    branchName: entry.branchName,
    sourceBranch: entry.sourceBranch,
    title: entry.title ?? null,
  }
}

/** Drop a worktree's registry entry (after a retire). */
export function unregisterWorktree(worktreePath: string): boolean {
  const before = loadRegistry()
  const after = before.filter((e) => e.worktreePath !== worktreePath)
  if (after.length !== before.length) {
    const saved = saveRegistry(after)
    if (saved) {
      invalidateWorktreeInventoryCache('worktree unregistered')
      log('unregistered worktree', { worktree_path: worktreePath })
    }
    return saved
  }
  return true
}

/** Look up a worktree's recorded source branch, or null when unknown. */
export function lookupSourceBranch(worktreePath: string): string | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.sourceBranch ?? null
}

/**
 * The source-branch commit this worktree is based on, or null when the record
 * predates base tracking (or Ion has no record). See the `baseSha` field
 * comment for why this is stored rather than derived.
 */
export function lookupWorktreeBase(worktreePath: string): string | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.baseSha ?? null
}

/**
 * Advance a worktree's recorded base after a successful sync.
 *
 * Called only from the sync path (worktree/integrate.ts), which is the only
 * code that witnesses the transition — after `git rebase --onto <source>` the
 * worktree is based on the tip the sync captured, and recording anything else
 * (or nothing) would send the NEXT sync through the imprecise fallback.
 *
 * A worktree with no registry entry is not created here, for the same reason
 * `markWorktreeLanded` refuses to: inventing an entry with a fabricated
 * `sourceBranch` is the failure mode the registry's null-source rule prevents.
 */
export function setWorktreeBase(worktreePath: string, baseSha: string): boolean {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (!existing) {
    warn('cannot record base, no registry entry', { worktree_path: worktreePath })
    return false
  }
  const previous = existing.baseSha
  existing.baseSha = baseSha
  const saved = saveRegistry(entries)
  if (saved) {
    log('worktree base advanced', {
      worktree_path: worktreePath,
      base_sha: baseSha.slice(0, 7),
      previous: (previous ?? '').slice(0, 7),
    })
  }
  return saved
}
