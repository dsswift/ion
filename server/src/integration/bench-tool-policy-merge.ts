/**
 * Bench merge-state probes and the side-checkout resolution form — split from
 * bench-tool-policy.ts at the "what does the open merge permit" seam so both
 * files stay under the 600-line cap.
 *
 * Every probe here fails CLOSED: an unreadable merge state reports "no merge"
 * and an unreadable unmerged set reports "nothing unmerged", so a carve-out
 * that depends on them refuses exactly as it would without the carve-out — the
 * conservative direction for a permission widening.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { GitOperation } from './bench-bash-destinations'
import { benchRelativePath, runGit } from './bench-tool-policy-attribution'
import { log as _log } from '../logger'

const TAG = 'bench.tool-policy'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * True when a merge is open in the bench (MERGE_HEAD exists). `--git-path`
 * because a bench is a linked worktree whose state lives under the common
 * dir; a hardcoded `.git/MERGE_HEAD` join would miss it.
 */
export function mergeInProgress(benchPath: string): boolean {
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

/** The bench-relative paths with unmerged index entries; empty when unreadable. */
function unmergedPaths(benchPath: string): string[] {
  try {
    return runGit(benchPath, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n').map((line) => line.trim()).filter((line) => line !== '')
  } catch (err) {
    log('unmerged-path probe failed, treating as none unmerged', { bench_path: benchPath, error: String(err) })
    return []
  }
}

/**
 * Whether target is one of the bench merge's unmerged paths. Only meaningful
 * while mergeInProgress.
 */
export function isUnmergedPath(benchPath: string, canonicalTarget: string, canonicalBenchPath: string): boolean {
  const rel = benchRelativePath(canonicalTarget, canonicalBenchPath)
  if (rel === null) return false
  return unmergedPaths(benchPath).includes(rel)
}

/** A `git checkout` that takes one side of a conflict for named pathspecs. */
export interface SideCheckout {
  side: 'ours' | 'theirs'
  /** The pathspecs as written, quotes stripped. Never empty. */
  pathspecs: string[]
}

/**
 * Parse `git checkout --ours|--theirs [--] <pathspec>...`, or null for every
 * other checkout form.
 *
 * Git rejects `--ours`/`--theirs` when switching branches, so this form can
 * only rewrite working-tree files from the index — it cannot move the bench
 * branch, which is what the bench refuses `checkout` for. The grammar is
 * exact: any other option, both sides at once, no pathspec, or a pathspec the
 * shell would expand all return null and fall to the generic refusal.
 */
export function parseSideCheckout(op: GitOperation): SideCheckout | null {
  if (op.subcommand !== 'checkout') return null
  let side: SideCheckout['side'] | null = null
  let optionsEnded = false
  const pathspecs: string[] = []
  for (const raw of op.arguments) {
    const token = raw.replace(/^["']+|["']+$/g, '')
    if (!optionsEnded && token === '--') { optionsEnded = true; continue }
    if (!optionsEnded && token.startsWith('-')) {
      if (token !== '--ours' && token !== '--theirs') return null
      const named = token === '--ours' ? 'ours' : 'theirs'
      if (side !== null && side !== named) return null
      side = named
      continue
    }
    if (/[$`*?]/.test(token) || token.startsWith('~')) return null
    pathspecs.push(token)
  }
  if (side === null || pathspecs.length === 0) return null
  return { side, pathspecs }
}

/**
 * Whether every canonical target is the resolution of an open bench merge: a
 * merge is in progress, and each target is an unmerged path, a directory that
 * contains one, or the bench root. A target that reaches no conflicted file
 * would discard bench content rather than resolve anything, so one such target
 * fails the whole call.
 */
export function coversOnlyConflicts(benchPath: string, canonicalBenchPath: string, canonicalTargets: string[]): boolean {
  if (!mergeInProgress(benchPath)) return false
  const unmerged = unmergedPaths(benchPath)
  if (unmerged.length === 0) return false
  return canonicalTargets.every((target) => {
    if (target === canonicalBenchPath) return true
    const rel = benchRelativePath(target, canonicalBenchPath)
    if (rel === null) return false
    return unmerged.some((path) => path === rel || path.startsWith(`${rel}/`))
  })
}
