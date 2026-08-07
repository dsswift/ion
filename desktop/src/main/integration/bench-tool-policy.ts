/**
 * Client tool-gate policy — the desktop's answer to an engine
 * engine_tool_gate_request for BENCH containment.
 *
 * ── What this decides ───────────────────────────────────────────────────────
 * Whether an agent tool call may proceed, judged against the integration-bench
 * rules the desktop owns the records for:
 *
 *   - a file write TARGETING a bench is refused (the next assembly destroys
 *     it), except the resolve-once carve-out for an in-progress merge's
 *     unmerged paths;
 *   - a Bash command whose PROVEN destination is inside a bench and invokes a
 *     history-writing git verb is refused, except the standalone exact merge
 *     drivers while a machinery-prepared merge is open;
 *   - a bench-cwd conversation writing OUTSIDE the bench is judged by the
 *     bench-origin rules: enrolled enabled member worktrees pass (that is the
 *     named remediation), the source checkout and non-member worktrees refuse.
 *
 * Worktree isolation (base repo / sibling worktree / worktree identity) stays
 * in the engine — this module deliberately carries none of it.
 *
 * ── Not a cwd jail ──────────────────────────────────────────────────────────
 * Writes to /tmp, ~/.ion, an unrelated repository, or any other directory
 * pass: agents legitimately need them, and over-blocking would make bench
 * conversations useless for real work. The bench's only purpose is to build
 * and test, so reads, builds, staging, and discarding always pass.
 *
 * ── Fail open on the records, fail closed on the carve-outs ────────────────
 * A missing or corrupt workspaces record allows everything (loadWorkspaces
 * already tolerates both): a false refusal where the operator works is worse
 * than a briefly missing guard. The CARVE-OUT probes fail CLOSED — an
 * unreadable merge-state probe reports "no merge", so the check refuses
 * exactly as it would without the carve-out, the conservative direction for a
 * permission widening.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { loadWorkspaces } from './bench-store'
import {
  resolveBashDestinations, effectiveDir, type BashSegment,
} from './bench-bash-destinations'
import {
  attributeOwners, benchHistoryReason, benchRelativePath, benchSourceCheckoutReason,
  benchWriteReason, disabledMemberReason, nonMemberWorktreeReason, runGit,
} from './bench-tool-policy-attribution'
import { log as _log, warn as _warn } from '../logger'
import type { IntegrationWorkspace } from '../../shared/types'

const TAG = 'bench.tool-policy'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface GateRequest {
  toolName: string
  input: Record<string, unknown>
  cwd: string
  /**
   * Names of the OTHER tool calls in the same model turn. Turn-mates run
   * concurrently, so `git merge --continue` cannot share a turn with anything:
   * a failed edit, formatter, test, or stage command must not be maskable by
   * later merge completion.
   */
  siblingTools?: string[]
}

export interface GateDenial { reason: string }

/**
 * The set of tool names this gate inspects. These are the calls that put
 * bytes on disk; read and dispatch tools cannot violate containment. Matches
 * the engine's gatedTools convention (both casings arrive on the wire).
 */
const GATED_TOOLS: ReadonlySet<string> = new Set(['Write', 'write', 'Edit', 'edit', 'NotebookEdit', 'Bash', 'bash', 'ion_scaffold'])

/**
 * The git verbs refused inside a bench. Each either creates a commit the next
 * assembly destroys, publishes a synthetic merge, moves the bench branch out
 * from under the assembly's `switch -C`, or anchors a synthetic commit behind
 * a ref that outlives the assembly. `pull` is fetch-plus-merge: it writes
 * history exactly like `merge`. `tag` both survives the assembly that
 * destroys its target and is pushable.
 *
 * Deliberately ABSENT: add, rm, restore, clean, apply — index and working-tree
 * verbs that `--discard-changes` already resets, and blocking them would stop
 * the operator inspecting or tidying a bench tree (`apply` is how hunk-level
 * staging works). Also absent: every read verb. Over-blocking is as much a
 * defect as under-blocking: the bench's only purpose is to build and test.
 */
const HISTORY_WRITING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'commit', 'push', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset',
  'branch', 'checkout', 'switch', 'stash', 'tag', 'am', 'filter-branch',
])

/**
 * Decide whether a tool call may proceed. Returns null to allow, or a denial
 * with the complete model-facing reason: it names the offending path, what
 * that path belongs to, and where the work belongs instead — a refusal the
 * model can act on rather than merely retry.
 *
 * Fails OPEN on any unexpected error reading the records: the engine enforces
 * worktree isolation independently, and a false refusal where the operator
 * works is worse than a briefly missing bench guard.
 */
export function evaluateToolGate(req: GateRequest): GateDenial | null {
  if (!GATED_TOOLS.has(req.toolName)) return null
  try {
    return evaluate(req)
  } catch (err) {
    warn('tool gate evaluation failed, allowing the call', {
      tool: req.toolName, cwd: req.cwd, error: String(err),
    })
    return null
  }
}

function evaluate(req: GateRequest): GateDenial | null {
  const benches = loadWorkspaces()
  if (benches.length === 0) return null

  if (req.toolName === 'Bash' || req.toolName === 'bash') {
    const command = req.input['command']
    // A Bash call with no command string has nothing to judge.
    if (typeof command !== 'string' || command === '') return null
    return checkBash(command, req.cwd, benches, req.siblingTools ?? [])
  }

  const target = extractTargetPath(req.input, req.cwd)
  if (target === '') return null
  return checkWriteTarget(target, req.cwd, benches)
}

// ─── Write-target rules ──────────────────────────────────────────────────────

/**
 * Resolve a write tool's target to an absolute path. Field names cover the
 * core write tools (file_path, notebook_path) and common variants, matching
 * the engine's extractTargetPath.
 */
function extractTargetPath(input: Record<string, unknown>, cwd: string): string {
  for (const key of ['file_path', 'path', 'filePath', 'notebook_path', 'targetDir']) {
    const v = input[key]
    if (typeof v !== 'string' || v === '') continue
    if (isAbsolute(v)) return clean(v)
    if (cwd !== '') return clean(join(cwd, v))
    return ''
  }
  return ''
}

/**
 * Classify one absolute write target against the global bench set (a bench
 * must refuse writes even from a conversation running elsewhere — the TARGET
 * decides, not the cwd) plus the bench-origin rules when cwd is a bench.
 */
function checkWriteTarget(target: string, cwd: string, benches: IntegrationWorkspace[]): GateDenial | null {
  const canonicalTarget = canonicalize(target)

  const bench = benchFor(canonicalTarget, benches)
  if (bench) {
    const canonicalBench = canonicalize(bench.benchPath)
    // Resolve-once carve-out: an edit to a path that is UNMERGED in the
    // bench's in-progress merge is the resolution itself — the artifact git
    // rerere records when the merge commits.
    if (mergeInProgress(bench.benchPath) && isUnmergedPath(bench.benchPath, canonicalTarget, canonicalBench)) {
      log('bench write allowed: resolve-once carve-out', { bench_path: bench.benchPath, target: canonicalTarget })
      return null
    }
    const owners = attributeOwners(bench, canonicalTarget, canonicalBench)
    const reason = benchWriteReason(canonicalTarget, bench, owners)
    warn('bench write refused', { bench_path: bench.benchPath, target: canonicalTarget, owners: owners.map((o) => o.branchName) })
    return { reason }
  }

  // A conversation whose cwd is a BENCH writes into the member worktrees the
  // bench is assembled from. That is the entire remediation the bench refusal
  // names, so it must be reachable — see benchOriginRefusal.
  const cwdBench = benchFor(canonicalize(cwd), benches)
  if (cwdBench) return benchOriginRefusal(cwdBench, canonicalTarget)

  return null
}

/**
 * Decide a write from a BENCH conversation to a target outside that bench.
 *
 * ── Why an enrolled member destination must pass ────────────────────────────
 * The bench write refusal names its own remediation: "make the change at
 * <member worktree>, commit it there, then update that member in the bench."
 * A conversation diagnosing an assembled failure runs IN the bench — that is
 * where the failing build is — so if bench-origin writes were refused
 * everywhere outside the bench, the remediation the guard prints would itself
 * be refused. The rule would then have no compliant path at all, which is how
 * a guard stops being a guard and becomes something to work around.
 *
 * ── Why only ENABLED and only ENROLLED ─────────────────────────────────────
 *   - An ENROLLED, ENABLED member owns bench content. A fix routed there is
 *     the fix reaching the code the bench actually built.
 *   - A DISABLED member is enrolled but excluded from the assembly. Its
 *     content is NOT in the bench, so a failure observed in the bench cannot
 *     originate from it, and an edit routed to it would be a change to
 *     unrelated work justified by evidence that does not apply to it.
 *   - An ARBITRARY worktree of the same repo is not a member at all. Another
 *     conversation owns that checkout.
 *   - The SOURCE CHECKOUT is never a valid destination: landing work directly
 *     in the source branch bypasses the whole integration model.
 *
 * Directories that are none of these — /tmp, ~/.ion, an unrelated repository —
 * pass, exactly as they do for a worktree conversation. Not a cwd jail.
 */
function benchOriginRefusal(bench: IntegrationWorkspace, target: string): GateDenial | null {
  for (const m of bench.members) {
    if (!within(target, m.worktreePath)) continue
    // Absent `enabled` means enabled — enrollment defaults to included.
    if (m.enabled !== false) {
      log('bench-origin write into enrolled member allowed', {
        bench_path: bench.benchPath, member_branch: m.branchName, member_path: m.worktreePath, target,
      })
      return null
    }
    warn('bench-origin write into disabled member refused', {
      bench_path: bench.benchPath, member_branch: m.branchName, target,
    })
    return { reason: disabledMemberReason(target, bench, m.worktreePath, m.branchName) }
  }

  // The source checkout the bench integrates into.
  if (bench.repoPath !== '' && within(target, bench.repoPath)) {
    warn('bench-origin write into source checkout refused', { bench_path: bench.benchPath, target })
    return { reason: benchSourceCheckoutReason(target, bench) }
  }

  // Any other worktree of the same repository: enrolled in nothing here, and
  // owned by another conversation.
  for (const e of loadWorktreeEntries()) {
    if (e.repoPath !== bench.repoPath || !within(target, e.worktreePath)) continue
    warn('bench-origin write into non-member worktree refused', {
      bench_path: bench.benchPath, worktree_path: e.worktreePath, target,
    })
    return { reason: nonMemberWorktreeReason(target, bench, e.worktreePath, e.branchName) }
  }

  return null
}

// ─── Bash rules ──────────────────────────────────────────────────────────────

/**
 * Judge a Bash command. A single command can `cd` out of the bench and commit
 * elsewhere, so every literal destination the command can be PROVEN to
 * operate in is checked — the cwd plus every literal `cd`/`pushd`/`git -C`/
 * `--work-tree` target. A dynamic destination (`cd "$VAR"`, `cd $(...)`)
 * cannot be resolved: it passes and is logged at WARN, because refusing on
 * unresolved destinations would refuse legitimate work, and `eval` defeats
 * any command-string parser anyway. Closing that gap needs process-level
 * containment, a different mechanism.
 */
function checkBash(command: string, cwd: string, benches: IntegrationWorkspace[], siblings: string[]): GateDenial | null {
  const dest = resolveBashDestinations(command, cwd)
  if (dest.unresolvedHint) {
    warn('bash destination unresolved, passing', { hint: dest.unresolvedHint, cwd })
  }

  // Turn isolation for `git merge --continue`: turn-mates run concurrently,
  // so continue cannot share a tool call or model response with other work —
  // a failed edit, formatter, test, or stage command must not be masked by
  // later merge completion. Mirrors the engine's pre-dispatch refusal in
  // runloop_tools.go, which fires on ANY classified continue in a bench
  // (exact or not) when siblings exist.
  if (siblings.length > 0) {
    for (const seg of dest.segments) {
      if (seg.mergeDriver !== 'continue') continue
      const gitDir = canonicalize(effectiveDir(seg.dir, cwd))
      if (benchFor(gitDir, benches)) {
        warn('bench merge continue refused: sibling tool calls in turn', { cwd, siblings })
        return {
          reason: 'Refused: run `git merge --continue` in a turn with no sibling tool calls. Tool calls in one response run concurrently, so merge completion must wait for a separate turn after all resolution, validation, and staging calls finish.',
        }
      }
    }
  }

  const cwdBench = benchFor(canonicalize(cwd), benches)

  // Every proven destination is judged as if the command ran there.
  for (const seg of dest.segments) {
    const segDir = seg.dir !== '' ? canonicalize(seg.dir) : ''
    // Bench history rules: judged for the directory the git invocation runs
    // in, which is the segment dir when proven, else the session cwd. Every
    // literal destination is canonicalized before comparison: a `cd /tmp/...`
    // on macOS resolves under /private, and an uncanonicalized comparison
    // would classify the same directory two different ways depending on which
    // side of the check it came from.
    const gitDir = segDir !== '' ? segDir : canonicalize(cwd)

    const bench = benchFor(gitDir, benches)
    if (!bench) {
      // A bench conversation whose segment runs OUTSIDE the bench is judged by
      // the bench-origin destination rules: history verbs in an enabled member
      // worktree are the remediation the bench refusal names (commit the fix
      // there), so they must pass, while the source checkout and non-member
      // worktrees stay refused. Only history verbs are judged — a build or
      // test command run elsewhere is not a containment concern.
      if (cwdBench && segDir !== '' && segmentWritesHistory(seg)) {
        const refusal = benchOriginRefusal(cwdBench, segDir)
        if (refusal) return refusal
      }
      continue
    }
    for (const sub of seg.gitSubcommands) {
      if (!HISTORY_WRITING_SUBCOMMANDS.has(sub)) continue
      // Resolve-once carve-out: only standalone merge drivers may act on an
      // open bench merge. Continue additionally requires a resolved index and
      // staged content that passes Git's whitespace/conflict-marker checks.
      if (sub === 'merge' && seg.mergeDriver !== '') {
        const refusal = checkBenchMergeDriver(seg, bench)
        if (refusal === null) continue
        return refusal
      }
      warn('bench history verb refused', { bench_path: bench.benchPath, subcommand: sub, dir: gitDir })
      return { reason: benchHistoryReason(sub, bench) }
    }
  }
  return null
}

function segmentWritesHistory(seg: BashSegment): boolean {
  return seg.gitSubcommands.some((sub) => HISTORY_WRITING_SUBCOMMANDS.has(sub))
}

/**
 * The merge-driver carve-out: `git merge --abort` while a merge is open, and
 * `git merge --continue` only when the merge is open, every unmerged path is
 * resolved and staged, and the staged content passes `git diff --cached
 * --check`. Both require the strict exact-call grammar — a malformed attempt
 * gets an actionable "run exactly" refusal instead of falling through to
 * generic bench history.
 */
function checkBenchMergeDriver(seg: BashSegment, bench: IntegrationWorkspace): GateDenial | null {
  const fields: Record<string, unknown> = {
    bench_path: bench.benchPath, merge_driver: seg.mergeDriver, exact_call: seg.mergeDriverExact,
  }
  const refuse = (why: string, detail: string): GateDenial => {
    warn('bench merge driver refused', { ...fields, decision: 'refuse', reason: why, detail })
    return { reason: detail }
  }

  if (!seg.mergeDriverExact) {
    return refuse('not_exact_call', `Refused: run exactly \`git merge --${seg.mergeDriver}\` as a standalone Bash call. Git global options may precede \`merge\`; wrappers, grouping, shell control, redirections, backgrounding, command substitution, extra options, and extra operands are not allowed.`)
  }
  if (!mergeInProgress(bench.benchPath)) {
    return refuse('no_merge', `Refused: no bench merge is open. Start conflict resolution through the bench resolve flow before running \`git merge --${seg.mergeDriver}\`.`)
  }
  if (seg.mergeDriver === 'abort') {
    log('bench merge driver allowed', { ...fields, decision: 'allow', reason: 'merge_open_abort' })
    return null
  }
  if (seg.mergeDriver !== 'continue') {
    return refuse('unsupported_driver', benchHistoryReason('merge', bench))
  }

  let unmerged = ''
  try {
    unmerged = runGit(bench.benchPath, ['diff', '--name-only', '--diff-filter=U'])
  } catch (err) {
    fields['error'] = String(err)
    return refuse('unmerged_probe_failed', 'Refused: could not verify whether bench merge conflicts remain. Resolve and stage every conflicted path, then retry standalone `git merge --continue`.')
  }
  const paths = nonEmptyLines(unmerged)
  fields['unmerged_count'] = paths.length
  if (paths.length > 0) {
    return refuse('unmerged_paths', `Refused: ${paths.length} unmerged path(s) remain in the bench. Resolve and stage every conflicted path, then retry standalone \`git merge --continue\`.`)
  }

  try {
    runGit(bench.benchPath, ['diff', '--cached', '--check'])
  } catch (err) {
    const detail = extractStdout(err).trim()
    fields['error'] = String(err)
    fields['staged_check'] = 'fail'
    return refuse('staged_check_failed', `Refused: staged bench resolution failed \`git diff --cached --check\`. Fix and restage the reported conflict markers or whitespace errors, then retry standalone \`git merge --continue\`. Git detail: ${detail}`)
  }
  log('bench merge driver allowed', { ...fields, staged_check: 'pass', decision: 'allow', reason: 'resolution_ready' })
  return null
}

/** stdout captured on a failed execFileSync, for the operator-facing detail. */
function extractStdout(err: unknown): string {
  const stdout = (err as { stdout?: unknown }).stdout
  return typeof stdout === 'string' ? stdout : ''
}

function nonEmptyLines(value: string): string[] {
  return value.split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

// ─── Merge-state probes (fail CLOSED) ───────────────────────────────────────

/**
 * True when a merge is open in the bench (MERGE_HEAD exists). `--git-path`
 * because a bench is a linked worktree whose state lives under the common
 * dir; a hardcoded `.git/MERGE_HEAD` join would miss it. Fails CLOSED for the
 * carve-outs that call it: an unreadable probe reports "no merge", so the
 * check refuses exactly as it would without the carve-out — the conservative
 * direction for a permission widening.
 */
function mergeInProgress(benchPath: string): boolean {
  try {
    const raw = runGit(benchPath, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()
    if (raw === '') return false
    const p = isAbsolute(raw) ? raw : resolve(benchPath, raw)
    return existsSync(p)
  } catch (err) {
    log('merge-in-progress probe failed, treating as none', { bench_path: benchPath, error: String(err) })
    return false
  }
}

/**
 * Whether target is one of the bench merge's unmerged paths. Only meaningful
 * while mergeInProgress; fails closed.
 */
function isUnmergedPath(benchPath: string, canonicalTarget: string, canonicalBenchPath: string): boolean {
  let out = ''
  try {
    out = runGit(benchPath, ['diff', '--name-only', '--diff-filter=U'])
  } catch (err) {
    log('unmerged-path probe failed, treating as not unmerged', { bench_path: benchPath, error: String(err) })
    return false
  }
  const rel = benchRelativePath(canonicalTarget, canonicalBenchPath)
  if (rel === null) return false
  return out.split('\n').some((line) => line.trim() === rel)
}

// ─── Containment primitives ──────────────────────────────────────────────────

/** Lexically clean a path, matching Go's filepath.Clean (no trailing sep). */
function clean(p: string): string {
  const n = normalize(p)
  if (n.length > 1 && n.endsWith(sep)) return n.slice(0, -1)
  return n
}

/**
 * Absolute, lexically clean, symlink-resolved form of a path.
 *
 * Canonicalization is load-bearing: every rule here is a comparison between a
 * path and a root, and on macOS /tmp and /var are symlinks to /private/...,
 * so a recorded path and a resolved cwd routinely differ by spelling for the
 * same directory — a raw string comparison would classify a bench as a plain
 * directory and pass every write it exists to refuse.
 *
 * Resolution walks from the deepest EXISTING ancestor: a write target need
 * not exist yet, and realpathSync on a nonexistent leaf fails outright, which
 * would leave every new-file write uncanonicalized while every existing-file
 * write was canonicalized — the two spellings would then disagree for the
 * same directory. Resolving the existing prefix and re-joining the missing
 * tail gives one answer for both. NEVER refuses on its own: an unresolvable
 * path falls back to its lexically-cleaned absolute form.
 */
function canonicalize(path: string): string {
  if (path === '') return ''
  if (!isAbsolute(path)) {
    // A relative path has no meaning without a base; callers resolve against
    // cwd first. Clean and return so the value is at least stable.
    return clean(path)
  }
  const abs = clean(path)
  try {
    return clean(realpathSync(abs))
  } catch {
    // Walk up to the deepest existing ancestor, resolve that, re-join.
  }
  let remainder = ''
  let current = abs
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return abs // reached the root, nothing resolvable
    remainder = remainder === '' ? basename(current) : join(basename(current), remainder)
    current = parent
    try {
      return clean(join(realpathSync(current), remainder))
    } catch {
      continue // silent-ok: keep walking up to a resolvable ancestor
    }
  }
}

/**
 * Whether path is root or a descendant of it, with BOTH sides canonicalized.
 *
 * The separator is REQUIRED on the descendant check. A bare
 * `path.startsWith(root)` would also match a sibling whose name merely begins
 * with the root — `…/ion-a33725460` against `…/ion-a3372546` — refusing
 * writes in an unrelated directory. A false refusal in the place the operator
 * is doing real work is worse than the guard not firing, so the check is
 * exact-or-separator-prefixed, never bare. The raw (cleaned) root is compared
 * too: a root that cannot be resolved (a bench whose directory was removed)
 * still has to enforce.
 */
function within(canonicalPath: string, root: string): boolean {
  if (canonicalPath === '' || root === '') return false
  return isWithin(canonicalPath, canonicalize(root)) || isWithin(canonicalPath, clean(root))
}

function isWithin(path: string, root: string): boolean {
  if (path === '' || root === '') return false
  if (path === root) return true
  return path.startsWith(root + sep)
}

/** The bench containing path, or null. Pass an already-canonical path. */
function benchFor(canonicalPath: string, benches: IntegrationWorkspace[]): IntegrationWorkspace | null {
  for (const b of benches) {
    if (b.benchPath && within(canonicalPath, b.benchPath)) return b
  }
  return null
}

// ─── Worktree registry read (non-member destination check) ──────────────────

interface WorktreeRegistryEntry {
  worktreePath: string
  repoPath: string
  branchName: string
}

/**
 * Read the worktree registry directly. The registry module
 * (main/worktree/registry.ts) keeps its reader private and this gate needs
 * only the three identity fields; a tolerant local read keeps the dependency
 * surface at the record, not the module. Missing or corrupt reads as empty —
 * the non-member refusal is the least critical bench-origin rule, and failing
 * open here matches the module-wide posture.
 */
function loadWorktreeEntries(): WorktreeRegistryEntry[] {
  const file = join(homedir(), '.ion', 'worktree-registry.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .filter((e) => typeof e['worktreePath'] === 'string' && typeof e['repoPath'] === 'string')
      .map((e) => ({
        worktreePath: e['worktreePath'] as string,
        repoPath: e['repoPath'] as string,
        branchName: typeof e['branchName'] === 'string' ? e['branchName'] as string : '',
      }))
  } catch (err) {
    warn('worktree registry unreadable, treating as empty', { path: file, error: String(err) })
    return []
  }
}
