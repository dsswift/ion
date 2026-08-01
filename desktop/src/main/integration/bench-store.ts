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
    return normalized
  } catch (err) {
    warn('workspaces file unreadable, starting empty', { path: file, error: String(err) })
    return []
  }
}

/** Persist the full workspace list atomically. */
export function saveWorkspaces(workspaces: IntegrationWorkspace[]): void {
  try {
    const dir = ionDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: WorkspacesFile = { version: 1, workspaces }
    atomicWriteFileSync(workspacesFile(), JSON.stringify(payload, null, 2), 0o644)
    log('workspaces saved', { count: workspaces.length })
  } catch (err) {
    // Losing the write means the member set is not durable; that is worth an
    // error, not a debug line.
    warn('failed to save workspaces', { path: workspacesFile(), error: String(err) })
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
    enabled: true,
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
  }
}

/**
 * Legacy `MemberStatus` values, read from records written before the state was
 * split into three axes. Kept only as an input shape for the migration below —
 * nothing produces these any more.
 */
type LegacyStatus = 'integrated' | 'pending' | 'landed' | 'stale' | 'conflicted' | 'missing' | 'excluded'

/** A persisted member as it may appear on disk: new shape, old shape, or both. */
type PersistedMember = Partial<IntegrationMember> & {
  status?: unknown
  /** Dropped on write: the worktree owns its own display name. */
  label?: unknown
}

/**
 * Map a legacy collapsed `status` onto the three axes it was hiding.
 *
 * The collapsed enum reported ONE fact where three were true, so this recovers
 * what it can and stays conservative where it cannot: a legacy `excluded`
 * record says nothing about whether its pin was fresh, so the pin is recomputed
 * from the tree hashes rather than guessed. That is exactly the information the
 * old ladder destroyed, and re-deriving it here is why the migration is worth
 * running rather than resetting everyone's benches.
 */
function migrateStatus(
  status: LegacyStatus,
  pinnedTreeHash: string,
  currentTreeHash: string,
  pinnedSha: string,
  pinnedBaseSha: string,
  enabled: boolean,
): { pin: PinState; merge: MergeOutcome } {
  // Recomputed rather than inferred from the status word: for `excluded` and
  // `conflicted` the old value carried no freshness information at all.
  const emptyPin = pinnedBaseSha !== '' && pinnedBaseSha === pinnedSha
  const derivedPin: PinState = emptyPin
    ? 'empty'
    : currentTreeHash && currentTreeHash !== pinnedTreeHash
      ? 'behind'
      : 'current'

  switch (status) {
    case 'pending': return { pin: 'empty', merge: enabled ? 'merged' : 'skipped' }
    case 'integrated': return { pin: 'current', merge: 'merged' }
    case 'stale': return { pin: 'behind', merge: 'merged' }
    case 'landed': return { pin: 'absorbed', merge: 'merged' }
    case 'missing': return { pin: 'gone', merge: 'unbuilt' }
    // Both of these said nothing about the pin, so it is derived above.
    case 'conflicted': return { pin: derivedPin, merge: 'conflicted' }
    case 'excluded': return { pin: derivedPin, merge: 'skipped' }
  }
}

function normalizeMember(raw: unknown): IntegrationMember | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as PersistedMember
  if (typeof m.worktreePath !== 'string' || !m.worktreePath) return null
  if (typeof m.branchName !== 'string' || !m.branchName) return null

  const enabled = typeof m.enabled === 'boolean' ? m.enabled : true
  const pinnedSha = typeof m.pinnedSha === 'string' ? m.pinnedSha : ''
  const pinnedTreeHash = typeof m.pinnedTreeHash === 'string' ? m.pinnedTreeHash : ''
  // Absent on records written before the contribution range was tracked.
  // Empty means UNKNOWN, never "empty contribution" — assembly resolves it once
  // against the member branch and backfills it. Defaulting it to the pinned sha
  // instead would declare every legacy member's contribution empty and skip
  // work that is genuinely integrated.
  const pinnedBaseSha = typeof m.pinnedBaseSha === 'string' ? m.pinnedBaseSha : ''
  const currentTreeHash = typeof m.currentTreeHash === 'string' ? m.currentTreeHash : ''

  const axes = resolveAxes(m, { enabled, pinnedSha, pinnedTreeHash, pinnedBaseSha, currentTreeHash })

  return {
    worktreePath: m.worktreePath,
    branchName: m.branchName,
    enabled,
    pin: axes.pin,
    merge: axes.merge,
    review: m.review === 'good' || m.review === 'issue' ? m.review : undefined,
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
  ctx: { enabled: boolean; pinnedSha: string; pinnedTreeHash: string; pinnedBaseSha: string; currentTreeHash: string },
): { pin: PinState; merge: MergeOutcome } {
  const PINS: readonly PinState[] = ['empty', 'current', 'behind', 'absorbed', 'gone']
  const MERGES: readonly MergeOutcome[] = ['unbuilt', 'merged', 'conflicted', 'skipped']
  const hasNewShape = PINS.includes(m.pin as PinState) && MERGES.includes(m.merge as MergeOutcome)
  if (hasNewShape) return { pin: m.pin as PinState, merge: m.merge as MergeOutcome }

  const LEGACY: readonly string[] = ['integrated', 'pending', 'landed', 'stale', 'conflicted', 'missing', 'excluded']
  if (typeof m.status === 'string' && LEGACY.includes(m.status)) {
    const migrated = migrateStatus(
      m.status as LegacyStatus,
      ctx.pinnedTreeHash, ctx.currentTreeHash, ctx.pinnedSha, ctx.pinnedBaseSha, ctx.enabled,
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
