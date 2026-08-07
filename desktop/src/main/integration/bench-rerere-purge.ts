import { basename, resolve } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { runGit } from '../git-runner'
import { log, warn } from '../logger'
import { forgetRererePaths } from './bench-resolution-validation'

export interface RererePurgeResult { ok: boolean; count: number; error?: string }

async function rrCachePath(directory: string): Promise<string> {
  const commonDir = (await runGit(directory, ['rev-parse', '--git-common-dir'])).trim()
  const cache = resolve(directory, commonDir, 'rr-cache')
  if (basename(cache) !== 'rr-cache') throw new Error('Refusing to access path outside rr-cache')
  return cache
}

export async function countRerereRecordings(directory: string): Promise<RererePurgeResult> {
  try {
    const cache = await rrCachePath(directory)
    const entries = await readdir(cache, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    })
    const count = entries.filter((entry) => entry.isDirectory()).length
    log('bench.rerere', 'counted conflict recordings', { directory, count })
    return { ok: true, count }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    warn('bench.rerere', 'could not count conflict recordings', { directory, error })
    return { ok: false, count: 0, error }
  }
}

export async function discardAllRerereRecordings(directory: string): Promise<RererePurgeResult> {
  const counted = await countRerereRecordings(directory)
  if (!counted.ok || counted.count === 0) return counted
  try {
    const cache = await rrCachePath(directory)
    await rm(cache, { recursive: true, force: true })
    log('bench.rerere', 'discarded all conflict recordings', { directory, count: counted.count })
    return counted
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    warn('bench.rerere', 'could not discard conflict recordings', { directory, count: counted.count, error })
    return { ok: false, count: counted.count, error }
  }
}

/**
 * Forget specific recordings by path, OUTSIDE any merge context.
 *
 * This is a targeted variant of the blunt `discardAllRerereRecordings` above,
 * and it shares its constraint: `git rerere forget` can only act within an
 * active merge (MERGE_HEAD present), so a caller with no merge open — which
 * this one is, by construction, since it is invoked from IPC against an
 * arbitrary bench directory — always gets `noContext` back. Kept here as the
 * general-purpose IPC surface; the bench-verification recovery flow uses
 * `forgetRecordingsForBranches` instead, which recreates the merge context
 * this needs before calling into the same underlying helper.
 */
export async function forgetRerereRecordings(directory: string, paths: string[]): Promise<RererePurgeResult> {
  const result = await forgetRererePaths(directory, paths)
  if (result.ok) return { ok: true, count: result.forgottenPaths.length }
  return {
    ok: false,
    count: result.forgottenPaths.length,
    error: 'error' in result ? result.error : 'No merge is in progress in this directory to forget within.',
  }
}
