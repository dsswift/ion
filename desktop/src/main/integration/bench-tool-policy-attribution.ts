/**
 * Bench write attribution and refusal messages — split from
 * bench-tool-policy.ts at the "who owns this file / what do we tell the
 * caller" seam so both files stay under the 600-line cap.
 *
 * ── Why "who last touched this file" is NOT used ────────────────────────────
 * The obvious attribution is `git log -1 -- <path>`, and it is wrong whenever
 * more than one member touches a file. Measured against this repository's own
 * bench: `AGENTS.md` is modified by all four enrolled members, so a
 * single-owner answer would be confidently wrong three times out of four —
 * sending the agent to edit a file in a worktree that does not own the change.
 *
 * The sound question is per-member and asked of every member: "did THIS
 * member's pinned contribution RANGE touch this path?", via
 * `git diff --name-only <base> <pinnedSha> -- <path>`. The range
 * (`pinnedBaseSha..pinnedSha`) is the question the assembly's merge actually
 * asks; a member's tip commit alone misses any collision introduced by an
 * earlier commit in the range. When the owning set has one element, name it.
 * When it has several, say so and list them with their changed line ranges so
 * the agent can pick by the region it is actually working in.
 */
import { execFileSync } from 'node:child_process'
import { relative, sep } from 'node:path'
import type { IntegrationWorkspace } from '../../shared/types'

/**
 * One bench member whose pinned contribution touches a refused path, with the
 * changed line ranges that make a multi-owner answer usable.
 */
export interface BenchOwner {
  worktreePath: string
  branchName: string
  /** Changed line ranges in the file, as "L<start>-<end>" strings. */
  hunks: string[]
}

/**
 * Run a git command in a directory and return stdout. Synchronous on purpose:
 * this runs on the gate hot path with a tight budget, and bench-guard.ts
 * already established execFileSync as the pattern for probe-only git.
 */
export function runGit(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * The bench-relative path of `canonicalTarget`, or null when the target is the
 * bench root itself or outside it. Slash-normalized to match git output.
 */
export function benchRelativePath(canonicalTarget: string, canonicalBenchPath: string): string | null {
  if (canonicalTarget === canonicalBenchPath) return null
  if (!canonicalTarget.startsWith(canonicalBenchPath + sep)) return null
  return relative(canonicalBenchPath, canonicalTarget).split(sep).join('/')
}

const HUNK_HEADER_RE = /^@@ .* \+(\d+)(?:,(\d+))? @@/

/**
 * Find every member whose pinned CONTRIBUTION RANGE touches target.
 *
 * Best-effort: a member whose diff cannot be read is omitted, and the refusal
 * still fires — attribution improves the message, it never turns a refusal
 * into a pass.
 */
export function attributeOwners(bench: IntegrationWorkspace, canonicalTarget: string, canonicalBenchPath: string): BenchOwner[] {
  const rel = benchRelativePath(canonicalTarget, canonicalBenchPath)
  if (rel === null) return []

  const owners: BenchOwner[] = []
  for (const m of bench.members) {
    if (!m.pinnedSha) continue
    const base = m.pinnedBaseSha || bench.baseSha
    if (!base) continue
    let changed = ''
    try {
      changed = runGit(bench.benchPath, ['diff', '--name-only', base, m.pinnedSha, '--', rel])
    } catch {
      continue // silent-ok: best-effort attribution; the refusal fires regardless
    }
    if (changed.trim() === '') continue
    owners.push({
      worktreePath: m.worktreePath,
      branchName: m.branchName,
      hunks: readHunks(bench.benchPath, base, m.pinnedSha, rel),
    })
  }
  return owners
}

/**
 * Changed line ranges for one member's contribution to one file. `-U0` gives
 * one hunk header per contiguous change. Capped: enough to orient the
 * redirect, not a full diff dump. Best-effort colour on an already-correct
 * refusal.
 */
function readHunks(benchPath: string, base: string, sha: string, rel: string): string[] {
  let out = ''
  try {
    out = runGit(benchPath, ['diff', '-U0', base, sha, '--', rel])
  } catch {
    return [] // silent-ok: hunks are colour, never load-bearing
  }
  const ranges: string[] = []
  for (const line of out.split('\n')) {
    const m = HUNK_HEADER_RE.exec(line)
    if (!m) continue
    const start = parseInt(m[1], 10)
    if (m[2] === undefined || m[2] === '1') {
      ranges.push(`L${start}`)
    } else {
      const n = parseInt(m[2], 10)
      ranges.push(`L${start}-${start + n - 1}`)
    }
    if (ranges.length >= 6) break
  }
  return ranges
}

/**
 * Names the read-only tool that answers ownership precisely. Every bench
 * refusal carries it: the refusal states an owner derived from file-level
 * ranges, and a caller editing specific lines has a more exact question
 * available — one that accounts for line shifts and reports every candidate
 * rather than one guess.
 */
export const ATTRIBUTION_HINT =
  ' For a precise answer — including which member owns a specific line range, every candidate when more than one member changed the file, and whether the content came from the source branch or from a recorded conflict resolution — use the WorkspaceAttribution tool, which is read-only.'

/**
 * The refusal message for a write into a bench, naming the owning member(s)
 * so the edit can be redirected rather than merely retried.
 */
export function benchWriteReason(target: string, bench: IntegrationWorkspace, owners: BenchOwner[]): string {
  let b = `Refused: ${target} is inside the integration bench ${bench.benchPath}. A bench is reassembled from scratch on every assembly, so an edit made here is destroyed by the next assembly and never reaches anyone.`
  if (owners.length === 0) {
    b += ` No enrolled member changes this file, so it comes from the source branch ${bench.sourceBranch}: make the change in a worktree cut from ${bench.sourceBranch} and land it.`
  } else if (owners.length === 1) {
    const o = owners[0]
    b += ` This file is integrated from member ${o.branchName}: make the change at ${o.worktreePath}, commit it there, then update that member in the bench.`
  } else {
    b += ` ${owners.length} members change this file, so the owner depends on which lines are being edited:`
    for (const o of owners) {
      const hunks = o.hunks.length > 0 ? o.hunks.join(', ') : 'unknown lines'
      b += ` ${o.branchName} at ${hunks} -> ${o.worktreePath};`
    }
    b += ' edit in the member that owns those lines, commit there, then update that member in the bench.'
  }
  b += ' Writes into an enrolled member worktree are permitted from this bench conversation, so the redirect above needs no new conversation.'
  b += ATTRIBUTION_HINT
  b += ' Reading, building, and testing in the bench are unaffected.'
  return b
}

/** The refusal for a history verb inside a bench. */
export function benchHistoryReason(subcommand: string, bench: IntegrationWorkspace): string {
  return `Refused: \`git ${subcommand}\` inside the integration bench ${bench.benchPath}. A bench branch is recreated from scratch on every assembly, so a commit made here is destroyed by the next assembly and a push would publish a synthetic merge of other people's in-flight work. Commit in the member worktree that owns the change — writes and commits in an enrolled member worktree are permitted from this bench conversation — then update that member in the bench. Reading, building, testing, and staging are unaffected.${ATTRIBUTION_HINT}`
}

/**
 * Why the repository the bench integrates into is never a write destination
 * from a bench conversation.
 */
export function benchSourceCheckoutReason(target: string, bench: IntegrationWorkspace): string {
  return `Refused: ${target} is inside the source checkout ${bench.repoPath} that the bench ${bench.benchPath} integrates into. Writing there commits straight onto ${bench.sourceBranch}, bypassing the integration model entirely, and leaves every conversation sharing that checkout with a dirty tree no review can attribute. Route the change to the member worktree that owns the content — those writes are permitted from this bench conversation — or, when the content comes from ${bench.sourceBranch} itself, to a worktree cut from ${bench.sourceBranch}.${ATTRIBUTION_HINT}`
}

/**
 * Why an unenrolled worktree of the same repository is not reachable from a
 * bench conversation.
 */
export function nonMemberWorktreeReason(target: string, bench: IntegrationWorkspace, worktreePath: string, branchName: string): string {
  const label = branchName || worktreePath
  return `Refused: ${target} is inside the worktree ${worktreePath} (${label}), which is NOT enrolled as a member of the bench ${bench.benchPath}. It belongs to another conversation, and writing there would interleave two conversations' work in one checkout — the same defect worktree isolation exists to prevent. Only enrolled member worktrees of this bench are writable from here.${ATTRIBUTION_HINT}`
}
