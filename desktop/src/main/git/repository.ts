/**
 * GitRepository — manages state, caching, and operation queue for a single git repo.
 *
 * Owns:
 * - An OperationQueue for serialized mutations and concurrent reads.
 * - LRU caches for commit details, commit files, diffs, and branches.
 * - A revision counter that bumps on every mutation for change detection.
 */

import { EventEmitter } from 'events'
import { OperationQueue } from './operationQueue'
import { LruCache } from './cache'
import { runGit } from '../git-runner'
import { parseGitStatus } from './diffs'
import type { StatusEntry } from './diffs'
import { parseGitLog, parseCommitStats, parseCommitFiles, parseBranches, LOG_FORMAT } from './refs'
import type { GitCommitRaw, CommitFileEntry, BranchEntry } from './refs'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('main', msg)
}

export interface RepoSnapshot {
  head: { branch: string | null; sha: string | null }
  upstream: { ahead: number; behind: number }
  files: StatusEntry[]
  revision: number
}

export class GitRepository extends EventEmitter {
  readonly path: string
  readonly queue: OperationQueue

  // Caches
  readonly commitDetailCache = new LruCache<string, { filesChanged: number; insertions: number; deletions: number }>(200)
  readonly commitFilesCache = new LruCache<string, CommitFileEntry[]>(200)
  readonly commitFileDiffCache = new LruCache<string, { diff: string; fileName: string }>(500)
  readonly diffCache = new LruCache<string, { diff: string; fileName: string }>(100)
  readonly branchCache = new LruCache<string, { branches: BranchEntry[]; current: string }>(1)
  readonly graphCache = new LruCache<string, { commits: GitCommitRaw[]; totalCount: number }>(20)

  private _revision = 0
  private _refCount = 0

  constructor(path: string) {
    super()
    this.path = path
    this.queue = new OperationQueue(4)
  }

  get revision(): number { return this._revision }
  get refCount(): number { return this._refCount }

  retain(): void { this._refCount++ }
  release(): boolean {
    this._refCount--
    return this._refCount <= 0
  }

  /** Bump revision after mutations — invalidates caches that depend on HEAD or working tree. */
  bumpRevision(): void {
    this._revision++
    // Invalidate volatile caches
    this.diffCache.clear()
    this.branchCache.clear()
    this.graphCache.clear()
  }

  /** Invalidate diff cache entries for a specific path. */
  invalidatePath(path: string): void {
    this.diffCache.invalidate((key) => key.startsWith(path + ':'))
  }

  // ─── Cached operations ───

  async getStatus(): Promise<{ files: StatusEntry[]; branch: string; ahead: number; behind: number; isGitRepo: boolean }> {
    try {
      await runGit(this.path, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { files: [], branch: '', ahead: 0, behind: 0, isGitRepo: false }
    }

    let branch = ''
    try {
      branch = (await runGit(this.path, ['branch', '--show-current'])).trim()
    } catch {}

    let ahead = 0
    let behind = 0
    try {
      ahead = parseInt((await runGit(this.path, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
      behind = parseInt((await runGit(this.path, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), 10) || 0
    } catch {}

    try {
      const output = await runGit(this.path, ['status', '--porcelain=v1', '-uall'])
      const files = parseGitStatus(output)
      return { files, branch, ahead, behind, isGitRepo: true }
    } catch {
      return { files: [], branch, ahead, behind, isGitRepo: true }
    }
  }

  async getGraph(skip = 0, limit = 100): Promise<{ commits: GitCommitRaw[]; isGitRepo: boolean; totalCount: number }> {
    try {
      await runGit(this.path, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { commits: [], isGitRepo: false, totalCount: 0 }
    }

    const cacheKey = `${skip}:${limit}`
    const cached = this.graphCache.get(cacheKey)
    if (cached) return { ...cached, isGitRepo: true }

    try {
      const logOutput = await runGit(this.path, [
        'log', '--all', `--format=${LOG_FORMAT}`, '--topo-order',
        `--skip=${skip}`, `-n`, `${limit}`,
      ])
      const commits = parseGitLog(logOutput)

      let totalCount = 0
      try {
        totalCount = parseInt((await runGit(this.path, ['rev-list', '--all', '--count'])).trim(), 10) || 0
      } catch {}

      this.graphCache.set(cacheKey, { commits, totalCount })
      return { commits, isGitRepo: true, totalCount }
    } catch {
      return { commits: [], isGitRepo: true, totalCount: 0 }
    }
  }

  async getCommitDetail(hash: string): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    return this.commitDetailCache.getOrComputeDedup(hash, async () => {
      const output = await runGit(this.path, ['show', '--stat', '--format=', hash])
      return parseCommitStats(output)
    })
  }

  async getCommitFiles(hash: string): Promise<CommitFileEntry[]> {
    return this.commitFilesCache.getOrComputeDedup(hash, async () => {
      const output = await runGit(this.path, ['diff-tree', '--no-commit-id', '-r', '--name-status', hash])
      return parseCommitFiles(output)
    })
  }

  async getCommitFileDiff(hash: string, filePath: string): Promise<{ diff: string; fileName: string }> {
    const key = `${hash}:${filePath}`
    return this.commitFileDiffCache.getOrComputeDedup(key, async () => {
      const output = await runGit(this.path, ['diff-tree', '-p', '--root', hash, '--', filePath])
      const fileName = filePath.split('/').pop() || filePath
      return { diff: output, fileName }
    })
  }

  async getBranches(): Promise<{ branches: BranchEntry[]; current: string }> {
    return this.branchCache.getOrComputeDedup('branches', async () => {
      const output = await runGit(this.path, [
        'branch', '-a', '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)',
      ])
      return parseBranches(output)
    })
  }

  dispose(): void {
    this.queue.cancelAll()
    this.commitDetailCache.clear()
    this.commitFilesCache.clear()
    this.commitFileDiffCache.clear()
    this.diffCache.clear()
    this.branchCache.clear()
    this.graphCache.clear()
    this.removeAllListeners()
  }
}
