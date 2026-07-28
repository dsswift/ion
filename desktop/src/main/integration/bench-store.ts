/**
 * Integration workspace persistence — the durable member set and its pins.
 *
 * ── What is durable and what is not ─────────────────────────────────────────
 * The member list and each member's PINNED contribution are the only durable
 * artifacts of a workspace. The bench worktree itself is disposable: it is
 * rebuilt from scratch on demand, so losing it costs a rebuild, never work.
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
 * rebuild time can recover once the source branch moves. A rebuild merges the
 * pins, never a fresh read of the member's tip, so updating one member cannot
 * drag in another member's half-finished work. Pins advance only on enrollment
 * or an explicit Update.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'

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
  label?: string
  pinnedSha: string
  pinnedTreeHash: string
  pinnedBaseSha: string
}): IntegrationMember {
  return {
    worktreePath: args.worktreePath,
    branchName: args.branchName,
    label: args.label || args.worktreePath.split('/').filter(Boolean).pop() || args.branchName,
    enabled: true,
    pinnedSha: args.pinnedSha,
    pinnedTreeHash: args.pinnedTreeHash,
    pinnedBaseSha: args.pinnedBaseSha,
    // Seeded to the pin: a freshly enrolled member is by definition current.
    currentTreeHash: args.pinnedTreeHash,
    // A member enrolled before it has committed anything contributes nothing, and
    // says so. Calling that `integrated` would claim content the bench does not
    // hold; the bench used to call it `landed` and delete the member outright.
    status: args.pinnedBaseSha !== '' && args.pinnedBaseSha === args.pinnedSha
      ? 'pending'
      : 'integrated',
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
  }
}

function normalizeMember(raw: unknown): IntegrationMember | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<IntegrationMember>
  if (typeof m.worktreePath !== 'string' || !m.worktreePath) return null
  if (typeof m.branchName !== 'string' || !m.branchName) return null
  return {
    worktreePath: m.worktreePath,
    branchName: m.branchName,
    label: typeof m.label === 'string' && m.label ? m.label : m.branchName,
    enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
    pinnedSha: typeof m.pinnedSha === 'string' ? m.pinnedSha : '',
    pinnedTreeHash: typeof m.pinnedTreeHash === 'string' ? m.pinnedTreeHash : '',
    // Absent on records written before the contribution range was tracked.
    // Empty means UNKNOWN, never "empty contribution" — rebuild resolves it once
    // against the member branch and backfills it. Defaulting it to the pinned sha
    // instead would declare every legacy member's contribution empty and skip
    // work that is genuinely integrated.
    pinnedBaseSha: typeof m.pinnedBaseSha === 'string' ? m.pinnedBaseSha : '',
    currentTreeHash: typeof m.currentTreeHash === 'string' ? m.currentTreeHash : '',
    status: m.status === 'integrated' || m.status === 'pending' || m.status === 'stale' ||
      m.status === 'conflicted' || m.status === 'missing' || m.status === 'excluded'
      ? m.status : 'stale',
    conflictPaths: Array.isArray(m.conflictPaths) ? m.conflictPaths.filter((p): p is string => typeof p === 'string') : undefined,
    conflictsWith: Array.isArray(m.conflictsWith) ? m.conflictsWith.filter((b): b is string => typeof b === 'string') : undefined,
  }
}
