// ion-meta bench WRITE gate.
//
// Refuses a write-class tool call whose target is inside an integration bench,
// and names the member worktree that owns the file so the agent can redirect
// rather than merely retry.
//
// Why this is separate from the history gate
// ------------------------------------------
// `bench-gate.ts` refuses git commands that write HISTORY (commit, push,
// rebase, …) — but it only ever inspects `Bash`. `Write` and `Edit` were never
// consulted, so an agent in a bench conversation could edit bench files
// freely. The edit succeeded, looked successful, and was silently destroyed by
// the next `git switch -C … --discard-changes`. That is the same invisible
// work-loss the history gate exists to prevent, left open on the other axis.
//
// Why Bash is NOT gated here
// --------------------------
// The bench exists to BUILD and TEST a combination of in-flight work. Gating
// `Bash` on cwd would refuse exactly that, so over-blocking would defeat the
// feature's only purpose. `Bash` remains governed by the history gate alone:
// a build is fine, a commit is not.
//
// Why "who last touched this file" is NOT used
// --------------------------------------------
// The obvious attribution is `git log -1 -- <path>`, and it is wrong whenever
// more than one member touches a file. Measured against this repository's own
// bench: `AGENTS.md` is modified by all four enrolled members, so a single-owner
// answer would be confidently wrong three times out of four — sending the agent
// to edit a file in a worktree that does not own the change.
//
// The sound question is per-member and asked of every member: "did THIS member
// touch this path?", via `git diff --name-only <base> <memberSha> -- <path>`.
// That returns the true owning SET. When it has one element, name it. When it
// has several, say so and list them with their changed line ranges so the agent
// can pick by the region it is actually working in — a judgement it is well
// placed to make and this gate is not. Reporting a true multi-owner answer is
// correct; guessing one owner is the "heuristic substituted for a precise
// mechanism" anti-pattern.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { extractTargetPath } from './git-gate'

/** Tool-call info shape the gate consumes. Mirrors the SDK's `ToolCallInfo`. */
export interface ToolCallInfo {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}

export interface BenchWriteDecision {
  block: boolean
  benchPath?: string
  targetPath?: string
  /** Members that touched this path, when attribution resolved. */
  owners?: MemberOwner[]
  reason?: string
}

/** One member worktree that modified the path in question. */
export interface MemberOwner {
  worktreePath: string
  branchName: string
  label: string
  /** Changed line ranges in the bench-relative path, e.g. `L22-30`. */
  hunks: string[]
}

export interface BenchMember {
  worktreePath: string
  branchName: string
  label?: string
  enabled?: boolean
  pinnedSha?: string
}

export interface BenchWorkspace {
  benchPath: string
  sourceBranch: string
  baseSha?: string
  members?: BenchMember[]
}

/**
 * Tools this gate applies to. Same set as git-gate's, minus `Bash` — see the
 * header for why gating Bash here would defeat the bench's purpose.
 */
const GATED_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'ion_scaffold'])

let workspaceCache: BenchWorkspace[] | null = null

/** Test seam: drop the cache so a fixture workspace file is re-read. */
export function _resetBenchWriteCacheForTests(): void {
  workspaceCache = null
}

/**
 * Decide whether `info` should be refused for targeting a bench.
 *
 * Cheap checks first: an ungated tool and a non-bench cwd both short-circuit
 * before any file is read or any git command runs.
 */
export function gateBenchWrite(info: ToolCallInfo, cwd: string): BenchWriteDecision {
  if (!cwd) return { block: false }
  if (!GATED_TOOLS.has(info.toolName)) return { block: false }

  const target = extractTargetPath(info.toolName, info.input, cwd)
  if (!target) return { block: false }

  // The TARGET decides, not the cwd: an agent working outside the bench that
  // writes into one must still be refused.
  const ws = resolveWorkspaceFor(target)
  if (!ws) return { block: false }

  const owners = attributeToMembers(ws, target)
  return {
    block: true,
    benchPath: ws.benchPath,
    targetPath: target,
    owners,
    reason: formatBenchWriteReason(target, ws, owners),
  }
}

/**
 * Which bench contains `path`, or null.
 *
 * Exact-or-separator-prefixed, never a bare `startsWith`: a sibling whose name
 * merely begins with the bench path (`…/ion-josh-other` against `…/ion-josh`)
 * must not be refused. Same rule as bench-guard.ts:resolveBenchFor.
 */
export function resolveWorkspaceFor(path: string): BenchWorkspace | null {
  for (const ws of loadWorkspaces()) {
    if (!ws.benchPath) continue
    if (path === ws.benchPath || path.startsWith(ws.benchPath + sep)) return ws
  }
  return null
}

/**
 * Find every enabled member whose pinned contribution touches `target`.
 *
 * Best-effort by design: a git failure yields an empty list and the caller
 * falls back to the generic message. Attribution improves a refusal; it must
 * never be able to turn one into a pass.
 */
export function attributeToMembers(ws: BenchWorkspace, target: string): MemberOwner[] {
  const base = ws.baseSha
  if (!base || !ws.members?.length) return []

  const relative = target.startsWith(ws.benchPath + sep)
    ? target.slice(ws.benchPath.length + 1)
    : target

  const owners: MemberOwner[] = []
  for (const member of ws.members) {
    if (member.enabled === false || !member.pinnedSha) continue
    try {
      const changed = git(ws.benchPath, ['diff', '--name-only', base, member.pinnedSha, '--', relative])
      if (!changed.trim()) continue
      owners.push({
        worktreePath: member.worktreePath,
        branchName: member.branchName,
        label: member.label || member.branchName,
        hunks: readHunks(ws.benchPath, base, member.pinnedSha, relative),
      })
    } catch {
      // silent-ok: attribution is an enhancement to the message. A member whose
      // diff cannot be read is omitted; the refusal still fires, and index.ts
      // logs the decision including how many owners were resolved.
      continue
    }
  }
  return owners
}

/**
 * Changed line ranges for one member, as `L<start>-<end>` strings.
 *
 * `-U0` gives one hunk header per contiguous change, which is what lets a
 * multi-owner refusal be actionable: the agent matches the region it is editing
 * against the member that owns those lines.
 */
function readHunks(benchPath: string, base: string, sha: string, relative: string): string[] {
  try {
    const raw = git(benchPath, ['diff', '-U0', base, sha, '--', relative])
    const ranges: string[] = []
    for (const line of raw.split('\n')) {
      // @@ -old,count +new,count @@
      const m = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m) continue
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      ranges.push(count <= 1 ? `L${start}` : `L${start}-${start + count - 1}`)
      if (ranges.length >= 6) break // enough to orient; not a full diff dump
    }
    return ranges
  } catch {
    // silent-ok: hunk detail is optional colour on an already-correct refusal.
    return []
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Read the bench workspaces.
 *
 * Home is resolved lazily (never captured at module load) so a test that
 * redirects HOME is not sent to the developer's real `~/.ion`. Fails OPEN on
 * every error: a false refusal where the operator is working is worse than a
 * briefly missing guard, and the desktop enforces the same rule independently.
 */
export function loadWorkspaces(): BenchWorkspace[] {
  if (workspaceCache !== null) return workspaceCache

  const file = join(homedir(), '.ion', 'integration-workspaces.json')
  if (!existsSync(file)) {
    workspaceCache = []
    return workspaceCache
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    const workspaces = (parsed as { workspaces?: unknown })?.workspaces
    workspaceCache = Array.isArray(workspaces)
      ? (workspaces as BenchWorkspace[]).filter((w) => typeof w?.benchPath === 'string' && w.benchPath.length > 0)
      : []
  } catch {
    // silent-ok: fail open, per the doc comment above. index.ts logs the
    // resulting pass decision, so the gate's behaviour stays observable.
    workspaceCache = []
  }
  return workspaceCache
}

/**
 * Build the refusal the LLM reads as its tool result.
 *
 * It must say where the edit BELONGS, not merely that it was refused — a
 * refusal that only says "no" gets retried verbatim.
 */
export function formatBenchWriteReason(
  target: string,
  ws: BenchWorkspace,
  owners: MemberOwner[],
): string {
  const head = [
    `ion-meta refused this write because \`${target}\` is inside the integration bench \`${ws.benchPath}\`.`,
    'A bench is rebuilt from scratch on every rebuild, so an edit made here is destroyed by the next rebuild and never reaches anyone.',
  ]

  if (owners.length === 1) {
    const o = owners[0]
    head.push(
      `This file is integrated from member \`${o.label}\` (\`${o.branchName}\`).`,
      `Make the change at \`${join(o.worktreePath, target.slice(ws.benchPath.length + 1))}\`, commit it there, then update that member in the bench.`,
    )
  } else if (owners.length > 1) {
    // The multi-owner case. Naming one would be a guess; listing all of them
    // with their line ranges lets the agent choose by the region it is editing.
    head.push(
      `${owners.length} members change this file, so the owner depends on which lines you are editing:`,
      owners
        .map((o) => `- \`${o.label}\` (\`${o.branchName}\`) at ${o.hunks.length ? o.hunks.join(', ') : 'unknown lines'} → ${o.worktreePath}`)
        .join(' '),
      'Edit in the member that owns the lines you are changing, commit there, then update that member in the bench.',
    )
  } else {
    head.push(
      `No enrolled member changes this file, so it comes from the base branch \`${ws.sourceBranch}\`.`,
      `Make the change in a worktree cut from \`${ws.sourceBranch}\` and land it, or in the member that should own it.`,
    )
  }

  head.push(
    'Reading, building, and testing in the bench are unaffected.',
    'Use the ion_bench_locate tool to check which member owns a path BEFORE editing.',
  )
  return head.join(' ')
}
