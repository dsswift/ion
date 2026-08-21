/**
 * Integration workspace persistence — the durable member set and its pins.
 *
 * ── What is durable and what is not ─────────────────────────────────────────
 * The member list and each member's PINNED contribution are the only durable
 * artifacts of a workspace. The bench worktree itself is disposable: it is
 * reassembled from scratch on demand, so losing it costs an assembly, never work.
 * Deleting this file loses the member set and nothing else.
 *
 * ── Keying ──────────────────────────────────────────────────────────────────
 * Workspaces are keyed by `(repoPath, sourceBranch)`. That is the mechanism
 * that keeps each project's — and each source branch's — integrations
 * separate. Two worktrees from different repos cannot land in one bench
 * because they resolve to different keys, not because some rule forbids it.
 *
 * ── Pins ────────────────────────────────────────────────────────────────────
 * `pinnedSha` / `pinnedTreeHash` record exactly what is integrated, and
 * `pinnedBaseSha` records where that contribution STARTS. The contribution is
 * the range `pinnedBaseSha..pinnedSha`, not the tip: an equal pair means the
 * member has committed nothing of its own, which is the one fact no git query at
 * assembly time can recover once the source branch moves. An assembly merges the
 * pins, never a fresh read of the member's tip, so updating one member cannot
 * drag in another member's half-finished work. Pins advance only on enrollment
 * or an explicit Update.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'
import { setWorktreeStage, lookupWorktreeStage } from '../worktree/registry'
import { legacyReviewToStage } from '../../shared/types-git'
import type { IntegrationWorkspace, IntegrationMember, PinState, MergeOutcome } from '../../shared/types'

const TAG = 'bench.store'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Paths are resolved LAZILY, never captured at module load.
 *
 * A `const` computed at import time freezes whatever HOME was when the module
 * first loaded. That is wrong in two ways: the main process can legitimately
 * resolve its data dir later, and it makes the paths unobservable — a test that
 * redirects HOME would silently write to the developer's real ~/.ion instead of
 * its fixture. Functions keep the resolution honest at every call.
 */
export function ionDir(): string { return join(homedir(), '.ion') }
export function workspacesFile(): string { return join(ionDir(), 'integration-workspaces.json') }
/** Root for bench worktrees: <ion-dir>/integration/<repo>-<slug>. */
export function integrationRoot(): string { return join(ionDir(), 'integration') }

/** On-disk shape. Versioned so a future migration has somewhere to hook. */
interface WorkspacesFile {
  version: 1
  workspaces: IntegrationWorkspace[]
}

/**
 * Stable key for a workspace. Both components matter: the same repo
 * integrating into two different source branches gets two benches.
 */
export function workspaceKey(repoPath: string, sourceBranch: string): string {
  return `${repoPath}\u0000${sourceBranch}`
}

/**
 * Filesystem-safe slug for a `(repo, branch)` pair, used for the bench
 * directory and branch names. Branch names may contain `/`, so every unsafe
 * character collapses to `-`.
 */
export function benchSlug(repoPath: string, sourceBranch: string): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() || 'repo'
  const branchSlug = sourceBranch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
  return `${repoName}-${branchSlug}`
}

/** Default bench worktree path for a workspace. */
export function benchPathFor(repoPath: string, sourceBranch: string): string {
  return join(integrationRoot(), benchSlug(repoPath, sourceBranch))
}

/** Default bench branch name for a workspace. */
export function benchBranchFor(sourceBranch: string): string {
  const slug = sourceBranch.replace(/[^a-zA-Z0-9._/-]+/g, '-')
  return `ion/bench/${slug}`
}

/**
 * Read every workspace from disk.
 *
 * A missing file is the normal first-run state and returns an empty list. A
 * corrupt file is logged and treated as empty rather than throwing: the member
 * set is recoverable by re-enrolling, and a parse error must not take out the
 * git panel.
 */
export function loadWorkspaces(): IntegrationWorkspace[] {
  const file = workspacesFile()
  if (!existsSync(file)) {
    log('no workspaces file yet', { path: file })
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WorkspacesFile>
    const list = Array.isArray(parsed.workspaces) ? parsed.workspaces : []
    const normalized = list.map(normalizeWorkspace).filter((w): w is IntegrationWorkspace => w !== null)
    log('workspaces loaded', { count: normalized.length, dropped: list.length - normalized.length })
    // Persist every one-way migration now. A review verdict moves into the
    // worktree registry. A disabled or excluded member is removed. This keeps
    // an empty workspace record when every old member is removed.
    if (hasLegacyMembershipKeys(list)) {
      log('stripping retired membership state from the workspaces file', { path: file })
      saveWorkspaces(normalized)
    }
    return normalized
  } catch (err) {
    warn('workspaces file unreadable, starting empty', { path: file, error: String(err) })
    return []
  }
}

/** True when a persisted member carries a key that migration removes. */
function hasLegacyMembershipKeys(raw: unknown[]): boolean {
  return raw.some((w) => {
    if (!w || typeof w !== 'object') return false
    const members = (w as { members?: unknown }).members
    return Array.isArray(members) && members.some((m) => (
      !!m && typeof m === 'object' && (
        'review' in (m as object) ||
        (m as { enabled?: unknown }).enabled === false ||
        (m as { status?: unknown }).status === 'excluded'
      )
    ))
  })
}

/** Persist the full workspace list atomically. */
export function saveWorkspaces(workspaces: IntegrationWorkspace[]): boolean {
  try {
    const dir = ionDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: WorkspacesFile = { version: 1, workspaces }
    atomicWriteFileSync(workspacesFile(), JSON.stringify(payload, null, 2), 0o644)
    log('workspaces saved', { count: workspaces.length })
    return true
  } catch (err) {
    // Losing the write means the member set is not durable; that is worth an
    // error, not a debug line.
    warn('failed to save workspaces', { path: workspacesFile(), error: String(err) })
    return false
  }
}

/** Find a workspace by its `(repo, branch)` key. */
export function findWorkspace(
  workspaces: IntegrationWorkspace[],
  repoPath: string,
  sourceBranch: string,
): IntegrationWorkspace | undefined {
  const key = workspaceKey(repoPath, sourceBranch)
  return workspaces.find((w) => workspaceKey(w.repoPath, w.sourceBranch) === key)
}

/** Every workspace belonging to a repo (one per source branch integrated into). */
export function workspacesForRepo(workspaces: IntegrationWorkspace[], repoPath: string): IntegrationWorkspace[] {
  return workspaces.filter((w) => w.repoPath === repoPath)
}

/** Build a fresh, empty workspace record for a `(repo, branch)` pair. */
export function makeWorkspace(repoPath: string, sourceBranch: string): IntegrationWorkspace {
  return {
    repoPath,
    sourceBranch,
    benchPath: benchPathFor(repoPath, sourceBranch),
    benchBranch: benchBranchFor(sourceBranch),
    members: [],
    baseSha: '',
    lastBuiltAt: 0,
  }
}

/**
 * Build a member record pinned at a known contribution.
 *
 * The contribution is always the member branch's committed HEAD — uncommitted
 * work cannot be integrated, so there is no mode to choose. See
 * bench-snapshot.ts for why that is structural rather than a default.
 */
export function makeMember(args: {
  worktreePath: string
  branchName: string
  pinnedSha: string
  pinnedTreeHash: string
  pinnedBaseSha: string
}): IntegrationMember {
  return {
    worktreePath: args.worktreePath,
    branchName: args.branchName,
    // A member enrolled before it has committed anything contributes nothing, and
    // says so. Calling that `current` would claim content the bench does not
    // hold; the bench used to call it `landed` and delete the member outright.
    pin: args.pinnedBaseSha !== '' && args.pinnedBaseSha === args.pinnedSha
      ? 'empty'
      : 'current',
    // Enrollment writes a pin, it does not merge. Only an assembly can say what
    // happened to this contribution, so the merge axis starts unbuilt rather
    // than claiming a success no build has produced.
    merge: 'unbuilt',
    pinnedSha: args.pinnedSha,
    pinnedTreeHash: args.pinnedTreeHash,
    pinnedBaseSha: args.pinnedBaseSha,
    // Seeded to the pin: a freshly enrolled member is by definition current.
    currentTreeHash: args.pinnedTreeHash,
  }
}

/**
 * Coerce a persisted record into a valid workspace, dropping entries that are
 * structurally unusable. Defensive because this file is user-visible on disk
 * and may be hand-edited or written by an older build.
 */
function normalizeWorkspace(raw: unknown): IntegrationWorkspace | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Partial<IntegrationWorkspace>
  if (typeof w.repoPath !== 'string' || !w.repoPath) return null
  if (typeof w.sourceBranch !== 'string' || !w.sourceBranch) return null

  const members = Array.isArray(w.members)
    ? w.members.map(normalizeMember).filter((m): m is IntegrationMember => m !== null)
    : []

  return {
    repoPath: w.repoPath,
    sourceBranch: w.sourceBranch,
    benchPath: typeof w.benchPath === 'string' && w.benchPath ? w.benchPath : benchPathFor(w.repoPath, w.sourceBranch),
    benchBranch: typeof w.benchBranch === 'string' && w.benchBranch ? w.benchBranch : benchBranchFor(w.sourceBranch),
    members,
    baseSha: typeof w.baseSha === 'string' ? w.baseSha : '',
    lastBuiltAt: typeof w.lastBuiltAt === 'number' ? w.lastBuiltAt : 0,
    // Absent on records written before atomic assembly: UNKNOWN, never failed.
    lastAssembly: w.lastAssembly === 'assembled' || w.lastAssembly === 'failed' ? w.lastAssembly : undefined,
    lastAssemblyError: typeof w.lastAssemblyError === 'string' && w.lastAssemblyError ? w.lastAssemblyError : undefined,
    lastAssemblyFailure: w.lastAssemblyFailure === 'conflict' || w.lastAssemblyFailure === 'verification'
      || w.lastAssemblyFailure === 'obstructed'
      ? w.lastAssemblyFailure
      : undefined,
    lastAssemblyVerification: normalizeVerification(w.lastAssemblyVerification),
  }
}

/**
 * Coerce a persisted verification-evidence record, dropping it entirely when
 * the shape is not recognisable. A hand-edited or partially-written record
 * must not surface a dialog with a missing command or a `replayedBranches`
 * that is not actually an array of strings.
 */
function normalizeVerification(
  raw: unknown,
): IntegrationWorkspace['lastAssemblyVerification'] {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Partial<NonNullable<IntegrationWorkspace['lastAssemblyVerification']>>
  if (typeof v.command !== 'string' || !v.command) return undefined
  if (typeof v.outputTail !== 'string') return undefined
  if (!Array.isArray(v.replayedBranches)) return undefined
  return {
    command: v.command,
    outputTail: v.outputTail,
    replayedBranches: v.replayedBranches.filter((b): b is string => typeof b === 'string'),
    diagnosticTreeAt: typeof v.diagnosticTreeAt === 'number' ? v.diagnosticTreeAt : undefined,
  }
}

/** A persisted member as it may appear on disk. */
type PersistedMember = Partial<IntegrationMember> & {
  /** Retired membership flag, read only to remove old records. */
  enabled?: unknown
  status?: unknown
  /** Dropped on write: the worktree owns its own display name. */
  label?: unknown
  /** Legacy per-pin review verdict, migrated into the worktree stage. */
  review?: unknown
}


/** Legacy status values read only while migrating an older workspace file. */
type LegacyStatus = 'integrated' | 'pending' | 'landed' | 'stale' | 'conflicted' | 'missing'

/** Move a legacy per-pin review verdict to the worktree registry once. */
function migrateLegacyReview(worktreePath: string, review: unknown): void {
  const stage = legacyReviewToStage(review)
  if (!stage) return
  if (lookupWorktreeStage(worktreePath)) {
    log('legacy review verdict ignored: worktree already has a stage', {
      worktree_path: worktreePath, legacy_review: String(review),
    })
    return
  }
  if (!setWorktreeStage(worktreePath, stage)) {
    warn('legacy stage migration persist failed', { worktree_path: worktreePath, stage })
  }
  log('migrated legacy review verdict to a work stage', {
    worktree_path: worktreePath, legacy_review: String(review), stage,
  })
}

/** Translate the former collapsed status into pin and merge facts. */
function migrateStatus(
  status: LegacyStatus,
  pinnedTreeHash: string,
  currentTreeHash: string,
  pinnedSha: string,
  pinnedBaseSha: string,
): { pin: PinState; merge: MergeOutcome } {
  const emptyPin = pinnedBaseSha !== '' && pinnedBaseSha === pinnedSha
  const derivedPin: PinState = emptyPin
    ? 'empty'
    : currentTreeHash && currentTreeHash !== pinnedTreeHash ? 'behind' : 'current'
  switch (status) {
    case 'pending': return { pin: 'empty', merge: 'skipped' }
    case 'integrated': return { pin: 'current', merge: 'merged' }
    case 'stale': return { pin: 'behind', merge: 'merged' }
    case 'landed': return { pin: 'absorbed', merge: 'skipped' }
    case 'missing': return { pin: 'gone', merge: 'unbuilt' }
    case 'conflicted': return { pin: derivedPin, merge: 'conflicted' }
  }
}

function normalizeMember(raw: unknown): IntegrationMember | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as PersistedMember
  if (typeof m.worktreePath !== 'string' || !m.worktreePath) return null
  if (typeof m.branchName !== 'string' || !m.branchName) return null

  // Membership is binary. A legacy disabled/excluded record is removed rather
  // than retained as a dormant member. The workspace stays, even when empty.
  if (m.enabled === false || m.status === 'excluded') return null
  const pinnedSha = typeof m.pinnedSha === 'string' ? m.pinnedSha : ''
  const pinnedTreeHash = typeof m.pinnedTreeHash === 'string' ? m.pinnedTreeHash : ''
  // Absent on records written before the contribution range was tracked.
  // Empty means UNKNOWN, never "empty contribution" — assembly resolves it once
  // against the member branch and backfills it. Defaulting it to the pinned sha
  // instead would declare every legacy member's contribution empty and skip
  // work that is genuinely integrated.
  const pinnedBaseSha = typeof m.pinnedBaseSha === 'string' ? m.pinnedBaseSha : ''
  const currentTreeHash = typeof m.currentTreeHash === 'string' ? m.currentTreeHash : ''

  const axes = resolveAxes(m, { pinnedSha, pinnedTreeHash, pinnedBaseSha, currentTreeHash })

  // A record written before stages existed may still carry a review verdict;
  // fold it into the registry once and drop the key from the member shape.
  migrateLegacyReview(m.worktreePath, m.review)

  return {
    worktreePath: m.worktreePath,
    branchName: m.branchName,
    pin: axes.pin,
    merge: axes.merge,
    pinnedSha,
    pinnedTreeHash,
    pinnedBaseSha,
    currentTreeHash,
    conflictPaths: Array.isArray(m.conflictPaths) ? m.conflictPaths.filter((p): p is string => typeof p === 'string') : undefined,
    conflictsWith: Array.isArray(m.conflictsWith) ? m.conflictsWith.filter((b): b is string => typeof b === 'string') : undefined,
    mergeResolution: m.mergeResolution === 'replayed' ? 'replayed' : undefined,
  }
}

/**
 * Resolve the three axes from a persisted record, whichever shape it is in.
 *
 * New records carry `pin`/`merge` directly. Records written before the split
 * carry the collapsed `status`, which is migrated once — `saveWorkspaces` then
 * writes the new shape with no `status` key, so a given file migrates exactly
 * once and never round-trips through the lossy form again.
 */
function resolveAxes(
  m: PersistedMember,
  ctx: { pinnedSha: string; pinnedTreeHash: string; pinnedBaseSha: string; currentTreeHash: string },
): { pin: PinState; merge: MergeOutcome } {
  const PINS: readonly PinState[] = ['empty', 'current', 'behind', 'absorbed', 'gone']
  const MERGES: readonly MergeOutcome[] = ['unbuilt', 'merged', 'conflicted', 'skipped']
  const hasNewShape = PINS.includes(m.pin as PinState) && MERGES.includes(m.merge as MergeOutcome)
  if (hasNewShape) return { pin: m.pin as PinState, merge: m.merge as MergeOutcome }

  const LEGACY: readonly string[] = ['integrated', 'pending', 'landed', 'stale', 'conflicted', 'missing']
  if (typeof m.status === 'string' && LEGACY.includes(m.status)) {
    const migrated = migrateStatus(
      m.status as LegacyStatus,
      ctx.pinnedTreeHash, ctx.currentTreeHash, ctx.pinnedSha, ctx.pinnedBaseSha,
    )
    log('migrated legacy member status', {
      worktree_path: String(m.worktreePath), legacy_status: m.status,
      pin: migrated.pin, merge: migrated.merge,
    })
    return migrated
  }

  // Neither shape is recognisable (hand-edited file, or a record from a build
  // that never wrote either). The conservative pair OFFERS an update rather than
  // claiming content the bench does not hold: `empty` + `unbuilt` cannot be
  // mistaken for a successful integration.
  warn('member record has no recognisable state, treating as unbuilt', {
    worktree_path: String(m.worktreePath),
  })
  return { pin: 'empty', merge: 'unbuilt' }
}
