/**
 * git-api-ops — the git operation verbs, headless: refresh, patch apply, tag
 * creation, file-at-revision, signature verification, recent refs, the
 * interactive-rebase driver, and conflict stage/accept.
 *
 * The companion of `git-api.ts` (which owns the read/write verbs), split
 * only to stay under the file-size cap. Same discipline: each entry is the
 * original arrow function relocated verbatim from
 * `desktop/src/main/ipc/git-extras.ts`, `git-rebase.ts`, and
 * `git-conflicts.ts`, minus the unused Electron event parameter.
 *
 * `GIT_SUBSCRIBE`/`GIT_UNSUBSCRIBE` are deliberately NOT here. They key a
 * subscription on the caller's identity (a `WebContents` in Electron), which
 * is the one thing in this group that genuinely differs per host, so they
 * live in `git-subscriptions.ts` behind a host-agnostic subscriber.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@ion/shared/types'
import { runGit, gitExec } from './git-runner'
import { benchGuard, resolveBenchFor } from '../integration/bench-guard'
import { benchMutationQueue } from '../integration/bench-mutation-queue'
import { continueBenchMerge } from '../integration/bench-merge-continue'
import { probeOperationState } from './operation-state'
import { repositoryManager } from './repositoryManager'
import { createOperationDir, cleanupDir } from '../utils/temp-dir'
import { log as _log, warn as _warn, error as _error } from '../logger'

const log = (msg: string, fields?: Record<string, unknown>): void => { _log('git-api-ops', msg, fields) }
const warn = (msg: string, fields?: Record<string, unknown>): void => { _warn('git-api-ops', msg, fields) }
const logError = (msg: string, fields?: Record<string, unknown>): void => { _error('git-api-ops', msg, fields) }

const REBASE_TAG = 'git.rebase'

/**
 * Resolve the in-progress operation to the git verb and the guard label for
 * an abort/continue request. Defaults to `rebase` when no operation is
 * detected: the error message from git ("no rebase in progress") is then the
 * honest answer to a stale button.
 */
async function operationVerb(directory: string): Promise<{ verb: 'rebase' | 'merge' | 'cherry-pick'; label: string }> {
  const probe = await probeOperationState(directory)
  if (probe.state === 'merging') return { verb: 'merge', label: 'merge' }
  if (probe.state === 'cherry-picking') return { verb: 'cherry-pick', label: 'cherry-pick' }
  return { verb: 'rebase', label: 'rebase' }
}

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

/** Channel-keyed git operation handlers. Merged into `GIT_HANDLERS` by `git-api.ts`. */
export const GIT_OPS_HANDLERS: Record<string, (payload: any) => Promise<unknown>> = {
  [IPC.GIT_REFRESH]: async ({ directory }: { directory: string }) => {
    // Per plan: never refuse a refresh. If no repo exists for this path,
    // create one on demand via repositoryManager.get() — it does NOT retain,
    // so no watcher is started, but refreshSnapshot() still computes a fresh
    // snapshot, emits events to any current subscribers, and caches the
    // snapshot for the next subscribe() call.
    if (!directory) {
      logError('GIT_REFRESH: empty directory, refusing')
      return { ok: false }
    }
    const wasRetained = repositoryManager.has(directory)
    const repo = repositoryManager.get(directory)
    log('git_refresh', { dir: directory, was_retained: wasRetained, revision: repo.revision, ref_count: repo.refCount })
    repo.bumpRevision()
    try {
      await repo.refreshSnapshot()
      log('git_refresh: done', { dir: directory, revision: repo.revision, ref_count: repo.refCount })
      return { ok: true }
    } catch (err) {
      logError(`GIT_REFRESH: refreshSnapshot failed for ${directory}: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  },

  [IPC.GIT_APPLY_PATCH]: async ({ directory, patch, reverse, cached }: { directory: string; patch: string; reverse?: boolean; cached?: boolean }) => {
    const args = ['apply', '--whitespace=nowarn']
    if (cached) args.push('--cached')
    if (reverse) args.push('-R')
    const opDir = createOperationDir('patch')
    try {
      const patchFile = join(opDir, 'apply.patch')
      writeFileSync(patchFile, patch)
      args.push(patchFile)
      await runGit(directory, args)
      return { ok: true }
    } catch (err: any) {
      logError(`gitApplyPatch failed: ${err.message}`)
      return { ok: false, error: err.message }
    } finally {
      cleanupDir(opDir)
    }
  },

  [IPC.GIT_TAG_CREATE]: async ({ directory, name, ref, message }: { directory: string; name: string; ref?: string; message?: string }) => {
    const refusal = benchGuard(directory, 'create a tag')
    if (refusal) return refusal
    try {
      const args = ['tag']
      if (message) args.push('-a', name, '-m', message)
      else args.push(name)
      if (ref) args.push(ref)
      await runGit(directory, args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_SHOW_FILE]: async ({ directory, hash, path }: { directory: string; hash: string; path: string }) => {
    try {
      const content = await runGit(directory, ['show', `${hash}:${path}`])
      return { ok: true, content }
    } catch (err: any) {
      return { ok: false, error: err.message, content: '' }
    }
  },

  [IPC.GIT_COMMIT_SIGNATURE]: async ({ directory, hash }: { directory: string; hash: string }) => {
    try {
      const out = await runGit(directory, ['log', '-1', '--format=%G?\t%GS\t%GK', hash])
      const [status, signer, key] = out.trim().split('\t')
      return { ok: true, status, signer, key }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_RECENT_REFS]: async ({ directory, limit }: { directory: string; limit?: number }) => {
    try {
      const out = await runGit(directory, ['log', '-g', '--format=%gs', 'HEAD', `-n`, String(limit ?? 100)])
      const refs: string[] = []
      const seen = new Set<string>()
      for (const line of out.split('\n')) {
        const match = line.match(/^checkout: moving from \S+ to (\S+)/)
        if (match) {
          const ref = match[1]
          if (!seen.has(ref)) { seen.add(ref); refs.push(ref) }
        }
      }
      return { ok: true, refs }
    } catch (err: any) {
      return { ok: false, error: err.message, refs: [] }
    }
  },

  [IPC.GIT_REBASE_TODO]: async ({ directory, onto }: { directory: string; onto: string }) => {
    try {
      const output = await runGit(directory, ['log', '--reverse', '--format=%H%x00%s', `${onto}..HEAD`])
      const commits = output.trim().split('\n').filter(Boolean).map(line => {
        const [hash, subject] = line.split('\x00')
        return { hash, subject, action: 'pick' as const }
      })
      return { commits, ok: true }
    } catch (err: any) {
      return { commits: [], ok: false, error: err.message }
    }
  },

  [IPC.GIT_REBASE_EXEC]: async ({ directory, onto, commits }: { directory: string; onto: string; commits: Array<{ hash: string; action: string }> }) => {
    const refusal = benchGuard(directory, 'rebase')
    if (refusal) return refusal
    const opDir = createOperationDir('rebase')
    try {
      const todoContent = commits
        .filter(c => c.action !== 'drop')
        .map(c => `${c.action} ${c.hash}`)
        .join('\n') + '\n'

      const todoFile = join(opDir, 'todo')
      writeFileSync(todoFile, todoContent)

      const env = { ...process.env, GIT_SEQUENCE_EDITOR: `cat "${todoFile}" >` }
      await gitExec('git', ['rebase', '-i', onto], { cwd: directory, maxBuffer: 10 * 1024 * 1024, env })

      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.stderr?.trim() || err.message }
    } finally {
      cleanupDir(opDir)
    }
  },

  [IPC.GIT_REBASE_ABORT]: async ({ directory }: { directory: string }) => {
    const op = await operationVerb(directory)
    const refusal = benchGuard(directory, `abort a ${op.label}`)
    if (refusal) return refusal
    const benchPath = resolveBenchFor(directory)
    const queue = op.verb === 'merge' ? benchMutationQueue(directory) : null
    try {
      if (queue) {
        await queue.enqueueMutation(() => runGit(directory, [op.verb, '--abort']))
      } else {
        await runGit(directory, [op.verb, '--abort'])
      }
      return { ok: true }
    } catch (err: any) {
      _warn(REBASE_TAG, 'git operation abort failed', {
        directory, operation: op.verb, bench_path: benchPath ?? '', error: err.message,
      })
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_REBASE_CONTINUE]: async ({ directory }: { directory: string }) => {
    const op = await operationVerb(directory)
    const refusal = benchGuard(directory, `continue a ${op.label}`)
    if (refusal) return refusal
    const benchPath = resolveBenchFor(directory)
    const queue = op.verb === 'merge' ? benchMutationQueue(directory) : null
    if (queue) {
      try {
        return await queue.enqueueMutation(() => continueBenchMerge(directory))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        _warn(REBASE_TAG, 'queued bench merge continue failed', {
          directory,
          bench_path: benchPath,
          error: message,
        })
        return { ok: false, error: message }
      }
    }

    try {
      await runGit(directory, ['-c', 'core.editor=true', op.verb, '--continue'])
      return { ok: true }
    } catch (err: any) {
      _warn(REBASE_TAG, 'git operation continue failed', {
        directory, operation: op.verb, bench_path: benchPath ?? '', error: err.message,
      })
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_OP_STATE]: async ({ directory }: { directory: string }) => {
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
  },

  [IPC.GIT_CONFLICT_STAGES]: async ({ directory, path }: { directory: string; path: string }) => {
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

  [IPC.GIT_CONFLICT_ACCEPT]: async ({ directory, path, side }: { directory: string; path: string; side: 'ours' | 'theirs' }) => {
      const refusal = benchGuard(directory, 'resolve a conflict')
      if (refusal) return refusal
      const acceptConflict = async (): Promise<{ ok: boolean; error?: string }> => {
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
      }

      const queue = benchMutationQueue(directory)
      if (queue) {
        // Callback is deliberately unqueued. Entering same queue again here
        // would deadlock behind this active mutation.
        return queue.enqueueMutation(acceptConflict)
      }
      return acceptConflict()
    },
}
