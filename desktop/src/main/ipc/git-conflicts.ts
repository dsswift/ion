/**
 * Conflict-resolution git IPC — the data plane behind the ConflictsDialog and
 * the 3-way MergeEditor.
 *
 * ── The three channels ──────────────────────────────────────────────────────
 * - GIT_OP_STATE: what operation is in progress (rebasing/merging/…), the
 *   branch it rewrites, what it applies onto, and one summary row per
 *   conflicted file (which sides exist: both-modified, add/add, delete/modify).
 * - GIT_CONFLICT_STAGES: the three index stages of one conflicted file — base
 *   (:1:), ours (:2:), theirs (:3:) — the inputs to a 3-way merge. A missing
 *   stage is a real shape (add/add has no base; delete/modify misses a side)
 *   and is reported as absent rather than empty-string-ambiguous.
 * - GIT_CONFLICT_ACCEPT: resolve one file wholesale to one side —
 *   `git checkout --ours|--theirs -- <path>` + `git add`, or `git rm` when the
 *   accepted side deleted the file.
 *
 * ── During a rebase, who is "ours"? ─────────────────────────────────────────
 * git swaps the sides: stage 2 ("ours") is the branch being rebased ONTO, and
 * stage 3 ("theirs") is the branch being rebased. That inversion is exactly the
 * confusion a resolution UI exists to remove, so GIT_OP_STATE returns *labels*
 * (oursLabel / theirsLabel) resolved from the operation state, and the UI
 * speaks in branch names, never bare ours/theirs.
 *
 * Mutating channels are bench-guarded like git-rebase.ts: resolving conflicts
 * inside an integration bench writes to a tree the next rebuild recreates.
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { runGit } from '../git-runner'
import { benchGuard } from '../integration/bench-guard'
import { probeOperationState } from '../git/operation-state'

const TAG = 'git.conflicts'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Which index stages exist for one unmerged path. */
interface StagePresence {
  base: boolean
  ours: boolean
  theirs: boolean
}

/** Read `git ls-files --unmerged` into per-path stage presence. */
async function stagePresence(directory: string): Promise<Map<string, StagePresence>> {
  const raw = await runGit(directory, ['ls-files', '--unmerged'])
  const map = new Map<string, StagePresence>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // "<mode> <sha> <stage>\t<path>"
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const path = line.slice(tab + 1).trim()
    const stage = line.slice(0, tab).trim().split(/\s+/)[2]
    const entry = map.get(path) ?? { base: false, ours: false, theirs: false }
    if (stage === '1') entry.base = true
    else if (stage === '2') entry.ours = true
    else if (stage === '3') entry.theirs = true
    map.set(path, entry)
  }
  return map
}

/** Human summary of a conflict's shape from its stage presence. */
function describeShape(p: StagePresence): string {
  if (p.base && p.ours && p.theirs) return 'both modified'
  if (!p.base && p.ours && p.theirs) return 'both added'
  if (p.base && !p.ours && p.theirs) return 'deleted by you, modified by them'
  if (p.base && p.ours && !p.theirs) return 'modified by you, deleted by them'
  return 'conflicted'
}

/**
 * Side labels for the current operation. During a rebase git inverts
 * ours/theirs (see header); a plain merge keeps them natural.
 */
async function sideLabels(
  directory: string,
): Promise<{ oursLabel: string; theirsLabel: string }> {
  const probe = await probeOperationState(directory)
  if (probe.state === 'rebasing') {
    // Stage 2 is the base the rebase builds on; stage 3 is the branch being
    // rebased (the operator's work).
    return {
      oursLabel: probe.onto ? `base (${probe.onto})` : 'base',
      theirsLabel: probe.branch ?? 'your branch',
    }
  }
  let branch = ''
  try {
    branch = (await runGit(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch (err) {
    log('could not resolve HEAD for side labels', { directory, error: String(err) })
  }
  return { oursLabel: branch || 'yours', theirsLabel: 'incoming' }
}

export function registerGitConflictsIpc(): void {
  /**
   * Operation snapshot: kind, branches, and one row per conflicted file. This
   * is the ConflictsDialog's whole read model in one call.
   */
  ipcMain.handle(IPC.GIT_OP_STATE, async (_event, { directory }: { directory: string }) => {
    try {
      const probe = await probeOperationState(directory)
      const labels = await sideLabels(directory)
      const presence = await stagePresence(directory)
      const files = [...presence.entries()].map(([path, p]) => ({
        path,
        shape: describeShape(p),
        hasBase: p.base,
        hasOurs: p.ours,
        hasTheirs: p.theirs,
      }))
      log('op state read', {
        directory,
        state: probe.state ?? 'none',
        branch: probe.branch ?? '',
        conflicted: files.length,
      })
      return {
        ok: true,
        state: probe.state ?? null,
        branch: probe.branch ?? null,
        onto: probe.onto ?? null,
        oursLabel: labels.oursLabel,
        theirsLabel: labels.theirsLabel,
        files,
      }
    } catch (err) {
      warn('op state read failed', { directory, error: String(err) })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * The three stages of one conflicted file. `null` content means the stage
   * does not exist (add/add, delete/modify) — distinct from an empty file.
   */
  ipcMain.handle(
    IPC.GIT_CONFLICT_STAGES,
    async (_event, { directory, path }: { directory: string; path: string }) => {
      const readStage = async (n: 1 | 2 | 3): Promise<string | null> => {
        try {
          return await runGit(directory, ['show', `:${n}:${path}`])
        } catch {
          // A missing stage is a normal conflict shape, not an error.
          return null
        }
      }
      try {
        const [base, ours, theirs] = await Promise.all([readStage(1), readStage(2), readStage(3)])
        const labels = await sideLabels(directory)
        log('stages read', {
          directory,
          path,
          has_base: base !== null,
          has_ours: ours !== null,
          has_theirs: theirs !== null,
        })
        return { ok: true, base, ours, theirs, ...labels }
      } catch (err) {
        warn('stages read failed', { directory, path, error: String(err) })
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  /**
   * Resolve one file wholesale to one side. When the accepted side has no
   * stage (it deleted the file), acceptance means removing the file.
   */
  ipcMain.handle(
    IPC.GIT_CONFLICT_ACCEPT,
    async (_event, { directory, path, side }: { directory: string; path: string; side: 'ours' | 'theirs' }) => {
      const refusal = benchGuard(directory, 'resolve a conflict')
      if (refusal) return refusal
      try {
        const presence = (await stagePresence(directory)).get(path)
        if (!presence) {
          return { ok: false, error: `${path} is not conflicted.` }
        }
        const sideExists = side === 'ours' ? presence.ours : presence.theirs
        if (sideExists) {
          await runGit(directory, ['checkout', `--${side}`, '--', path])
          await runGit(directory, ['add', '--', path])
        } else {
          // Accepting a deletion: the file goes away and the removal is staged.
          await runGit(directory, ['rm', '--', path])
        }
        log('conflict accepted', { directory, path, side, side_deleted: !sideExists })
        return { ok: true }
      } catch (err) {
        warn('conflict accept failed', { directory, path, side, error: String(err) })
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
