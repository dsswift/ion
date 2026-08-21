/**
 * Read one file as a bench member contributed it.
 *
 * Ported from engine/internal/workspaces/member_file.go as the BenchMemberFile
 * tool moves from the Go engine to the desktop as a client tool. The JSON
 * output shape is identical to the engine's.
 *
 * ── The question this answers, and why it needs a primitive ──────────────────
 * Resolving a bench conflict means deciding how several members' versions of
 * one file should combine. Doing that requires READING those versions — and the
 * bench itself holds only the merge in progress, so the member versions live at
 * each member's pinned sha, reachable through git but not on disk.
 *
 * Without a primitive, the resolving agent reconstructs them by hand: a
 * fifteen-minute merge in this repo spent twelve shell calls `cat`-ing one file
 * out of eight sibling worktrees and reading `git show :2:`/`HEAD:` variants,
 * with no attribution attached to any of it. Reading a sibling worktree's
 * working tree is also subtly WRONG: that directory holds whatever the member
 * has done since its pin, which is not what the bench is merging.
 *
 * So this reads the pinned contribution, names the member and sha it came from,
 * and refuses anything outside the resolved bench.
 *
 * ── Read-only, and bounded ──────────────────────────────────────────────────
 * Every git invocation is a query (`show`, `cat-file`, `rev-parse`), nothing is
 * written, and no member worktree is touched — the content comes from the bench
 * repository's object store. Binary content is reported as binary rather than
 * dumped, and an oversized file is truncated with the truncation stated, because
 * a silently cut file is indistinguishable from a short one.
 */
import type { IntegrationWorkspace } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import {
  attrGit, benchForPath, canonicalizePath, memberStale, shortSha,
} from './bench-attribution-support'
import { resolveRequestPath } from './bench-attribution'

const TAG = 'bench.memberfile'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Which version of a file to read: a member's pinned contribution (exactly
 * what the assembly merges for that member), or the bench base — the common
 * ancestor every member's contribution is applied on top of.
 */
export type MemberFileSource = 'member' | 'base'

/** MemberFileRequest asks for one file at one revision. */
export interface MemberFileRequest {
  /** Any path inside the bench; the bench is resolved from it. */
  benchPath: string
  /** The file, absolute or bench-relative. */
  path: string
  /** Branch name or worktree path. Required for 'member', ignored for 'base'. */
  member?: string
  /** Empty means 'member'. */
  source?: MemberFileSource
}

/**
 * Caps returned content.
 *
 * Large enough for the files that actually collide here (the worst offender in
 * the recorded incidents is ~600 lines of TSX), small enough that a stray
 * request for a generated bundle cannot flood a context window. Exceeding it
 * truncates and says so, rather than failing — a truncated head is usually
 * enough to decide, and an error would send the agent back to shelling out.
 * Matches the engine's MaxMemberFileBytes.
 */
export const MAX_MEMBER_FILE_BYTES = 256 * 1024

/** One member, as the result lists them. */
export interface MemberFileCandidate {
  branchName: string
  worktreePath: string
  pinnedSha?: string
  /** The member worktree has moved past its pin; its working tree differs. */
  stale?: boolean
}

/**
 * The complete answer. Like attribution, this never throws: every failure is
 * expressed in the result so a consumer has one shape to render and a model
 * gets an actionable message instead of a stack trace.
 */
export interface MemberFileResult {
  benchPath: string
  sourceBranch?: string
  source: MemberFileSource
  /** Bench-relative path that was read. */
  path: string
  /**
   * WHERE the content came from, so two versions of one file can never be
   * confused for each other. Empty for a base read.
   */
  memberBranch?: string
  memberWorktreePath?: string
  pinnedSha?: string
  /** The exact object the content was read from (`<sha>:<path>`). */
  revision?: string
  /**
   * False when the path is absent at that revision — a real and useful answer
   * (the member added the file, or deleted it), not a failure.
   */
  exists: boolean
  /** Git reports the blob as binary; content is then empty. */
  binary?: boolean
  /** The file at that revision, possibly truncated. */
  content?: string
  /** Full size of the blob, before any truncation. */
  bytes: number
  /** Content holds only the first MAX_MEMBER_FILE_BYTES. */
  truncated?: boolean
  /**
   * Every member of the bench, so a caller that named the wrong one
   * can correct itself without a second round trip.
   */
  members?: MemberFileCandidate[]
  /** Facts that change how the content should be read. */
  warnings?: string[]
  /** Set when the request itself was refused. No git ran. */
  rejection?: string
}

/**
 * Read one file at a member's pinned contribution, or at the bench base.
 * Read-only; never throws.
 */
export function memberFile(req: MemberFileRequest): MemberFileResult {
  const res: MemberFileResult = {
    benchPath: '', source: req.source || 'member', path: req.path, exists: false, bytes: 0,
  }

  const bench = benchForPath(canonicalizePath(req.benchPath))
  if (!bench) {
    res.rejection = `${req.benchPath} is not inside a registered integration bench, so there is no member set to read from`
    logMemberFile(res, req)
    return res
  }
  res.benchPath = bench.benchPath
  if (bench.sourceBranch) res.sourceBranch = bench.sourceBranch
  res.members = memberCandidates(bench)

  const resolved = resolveRequestPath(req.path, bench)
  if (resolved.rejection) {
    res.rejection = resolved.rejection
    logMemberFile(res, req)
    return res
  }
  res.path = resolved.rel

  const rev = resolveMemberRevision(bench, req, res)
  if (rev.rejection) {
    res.rejection = rev.rejection
    logMemberFile(res, req)
    return res
  }
  res.revision = `${rev.sha}:${resolved.rel}`

  readBlob(bench, rev.sha, resolved.rel, res)
  logMemberFile(res, req)
  return res
}

/**
 * Pick the sha to read from and fill the identity fields.
 *
 * A member is addressable by branch name or worktree path, because a caller
 * that has one rarely has the other: the bench prompt context lists both, a
 * conflict report names branches, and attribution returns worktree paths.
 */
function resolveMemberRevision(
  bench: IntegrationWorkspace, req: MemberFileRequest, res: MemberFileResult,
): { sha: string; rejection: string } {
  if (res.source === 'base') {
    if (!bench.baseSha) {
      return { sha: '', rejection: 'the bench record carries no baseSha, so the base revision cannot be resolved' }
    }
    return { sha: bench.baseSha, rejection: '' }
  }

  if (!req.member) {
    return { sha: '', rejection: "member is required when reading a member's version; name it by branch or worktree path (see members in this result)" }
  }
  const wanted = canonicalizePath(req.member)
  for (const m of bench.members) {
    if (m.branchName !== req.member && m.worktreePath !== req.member && canonicalizePath(m.worktreePath) !== wanted) {
      continue
    }
    if (!m.pinnedSha) {
      return { sha: '', rejection: `member ${m.branchName} has no pinned contribution recorded, so there is no revision to read` }
    }
    res.memberBranch = m.branchName
    res.memberWorktreePath = m.worktreePath
    res.pinnedSha = m.pinnedSha
    if (memberStale(m)) {
      (res.warnings ??= []).push(`member ${m.branchName} has moved past its pin, so its worktree differs from the content returned here; this is what the bench merges.`)
    }
    return { sha: m.pinnedSha, rejection: '' }
  }
  return { sha: '', rejection: `no member of this bench matches "${req.member}"; see members in this result for the member set` }
}

/** Fill content, size, and the binary/absent/truncated facts. */
function readBlob(bench: IntegrationWorkspace, sha: string, rel: string, res: MemberFileResult): void {
  const spec = `${sha}:${rel}`
  const warnings = (w: string): void => { (res.warnings ??= []).push(w) }

  // Size first: it decides whether reading the content is even affordable, and
  // `cat-file -s` is the cheap way to ask. A failure here is the absent case —
  // the path does not exist at that revision, which is a real answer.
  const size = attrGit(bench.benchPath, ['cat-file', '-s', spec])
  if (size.error !== null) {
    res.exists = false
    warnings(`${rel} does not exist at ${shortSha(sha)}; the member may have added or deleted it relative to this revision.`)
    return
  }
  res.exists = true
  const n = parseInt(size.out.trim(), 10)
  if (!Number.isNaN(n)) res.bytes = n

  // Binary detection through git's own numstat, which reports `-` for a binary
  // blob. Sniffing for NUL bytes ourselves would disagree with git on files git
  // considers text via .gitattributes, and git's answer is the one that governs
  // how the merge behaved.
  if (blobIsBinary(bench, sha, rel)) {
    res.binary = true
    warnings(`${rel} is binary at ${shortSha(sha)}, so its content is not returned; a line-level merge decision is not available for it.`)
    return
  }

  const content = attrGit(bench.benchPath, ['show', spec])
  if (content.error !== null) {
    warnings(`could not read ${spec}: ${content.error}`)
    return
  }
  if (content.out.length > MAX_MEMBER_FILE_BYTES) {
    res.content = content.out.slice(0, MAX_MEMBER_FILE_BYTES)
    res.truncated = true
    warnings(`content truncated to the first ${MAX_MEMBER_FILE_BYTES} bytes of ${content.out.length}; request a narrower question or use WorkspaceAttribution for a line range.`)
    return
  }
  res.content = content.out
}

/**
 * Ask git whether the blob is binary, via a numstat diff against the empty
 * tree. `-` in the added/removed columns is git's binary marker.
 */
function blobIsBinary(bench: IntegrationWorkspace, sha: string, rel: string): boolean {
  const empty = attrGit(bench.benchPath, ['hash-object', '-t', 'tree', '/dev/null'])
  if (empty.error !== null) return false
  const out = attrGit(bench.benchPath, ['diff', '--numstat', empty.out.trim(), sha, '--', rel])
  if (out.error !== null) return false
  return out.out.trim().startsWith('-\t-')
}

/**
 * The members in this bench, so a caller that named
 * the wrong one can correct itself in place.
 */
function memberCandidates(bench: IntegrationWorkspace): MemberFileCandidate[] {
  const out: MemberFileCandidate[] = []
  for (const m of bench.members) {
    const cand: MemberFileCandidate = { branchName: m.branchName, worktreePath: m.worktreePath }
    if (m.pinnedSha) cand.pinnedSha = m.pinnedSha
    if (memberStale(m)) cand.stale = true
    out.push(cand)
  }
  return out
}

/**
 * Record every outcome, including the refusals: a member-file read that
 * silently answered nothing is indistinguishable in the log from one that was
 * never attempted.
 */
function logMemberFile(res: MemberFileResult, req: MemberFileRequest): void {
  const fields: Record<string, unknown> = {
    bench_path: res.benchPath,
    path: res.path,
    source: res.source,
    member: req.member ?? '',
    exists: res.exists,
    bytes: res.bytes,
    binary: res.binary ?? false,
    truncated: res.truncated ?? false,
  }
  if (res.pinnedSha) {
    fields.member_branch = res.memberBranch
    fields.pinned_sha = shortSha(res.pinnedSha)
  }
  if (res.rejection) {
    fields.rejection = res.rejection
    warn('bench member file rejected', fields)
    return
  }
  if (res.warnings && res.warnings.length > 0) fields.warning_count = res.warnings.length
  log('bench member file read', fields)
}
