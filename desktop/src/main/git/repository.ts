/**
 * GitRepository — owns watcher, operation queue, caches, and the live snapshot
 * for a single git repository.
 *
 * On retain → watcher starts and the snapshot is hydrated; mutations bump
 * `revision` and emit deltas (`status:changed`, `head:changed`, `refs:changed`,
 * `upstream:changed`, `merge:changed`) that subscribers forward to renderers.
 *
 * Caches: commitDetail / commitFiles / commitFileDiff are content-addressed
 * (never invalidated); diff / branch / graph are volatile and cleared on
 * relevant watch events.
 */

import { EventEmitter } from 'events'
import { OperationQueue } from './operationQueue'
import { LruCache } from './cache'
import { createGitWatcher } from './watcher'
import type { GitWatcher, GitWatchEvent } from './watcher'
import { focusState } from './focus-state'
import { runGit } from '../git-runner'
import { partitionStatus } from './diffs'
import type { StatusEntry, PartitionedStatus } from './diffs'
import { parseGitLog, parseCommitStats, parseCommitFiles, parseBranches, LOG_FORMAT } from './refs'
import type { GitCommitRaw, CommitFileEntry, BranchEntry } from './refs'
import type {
  GitEvent, HeadInfo, UpstreamInfo, MergeState, RefDelta, RepoSnapshot,
} from '../../shared/types-git-events'
import type { GitChangedFile } from '../../shared/types-session'
import { log as _log } from '../logger'
import { isPathIgnoredByGitWatcher } from './ignore-paths'
import { readGitWatcherIgnoredDirectories } from '../settings-store'

function log(msg: string): void { _log('main', msg) }

function keyOf(f: GitChangedFile): string {
  return `${f.staged ? 's' : 'u'}:${f.status}:${f.conflictKind ?? ''}:${f.path}`
}

function diffFiles(prev: GitChangedFile[], next: GitChangedFile[]): {
  added: GitChangedFile[]; removed: string[]; modified: GitChangedFile[]
} {
  const prevByPath = new Map(prev.map((f) => [keyOf(f), f]))
  const nextByPath = new Map(next.map((f) => [keyOf(f), f]))
  const added: GitChangedFile[] = []
  const modified: GitChangedFile[] = []
  for (const [k, f] of nextByPath) {
    if (!prevByPath.has(k)) added.push(f)
  }
  for (const f of prev) {
    const k = keyOf(f)
    if (!nextByPath.has(k)) {
      const inNext = next.find((n) => n.path === f.path && n.staged === f.staged)
      if (inNext) modified.push(inNext)
    }
  }
  const removedPaths = new Set<string>()
  const nextKeys = new Set(next.map(keyOf))
  for (const f of prev) {
    if (!nextKeys.has(keyOf(f)) && !next.find((n) => n.path === f.path && n.staged === f.staged)) {
      removedPaths.add(f.path)
    }
  }
  return { added, removed: [...removedPaths], modified }
}

export class GitRepository extends EventEmitter {
  readonly path: string
  readonly queue: OperationQueue

  readonly commitDetailCache = new LruCache<string, { filesChanged: number; insertions: number; deletions: number }>(200)
  readonly commitFilesCache = new LruCache<string, CommitFileEntry[]>(200)
  readonly commitFileDiffCache = new LruCache<string, { diff: string; fileName: string }>(500)
  readonly diffCache = new LruCache<string, { diff: string; fileName: string }>(100)
  readonly branchCache = new LruCache<string, { branches: BranchEntry[]; current: string }>(1)
  readonly graphCache = new LruCache<string, { commits: GitCommitRaw[]; totalCount: number }>(20)

  private _revision = 0
  private _refCount = 0
  private _watcherIgnored = false
  private readonly _watcher: GitWatcher
  private readonly _onFocusChange = (focused: boolean): void => {
    this._watcher.setSuspended(!focused)
    if (focused) {
      log('Focus returned, refreshing snapshot for ' + this.path)
      this.refreshSnapshot().catch(() => {})
    }
  }
  private _snapshot: RepoSnapshot | null = null
  private _refreshing = false
  private _refreshAgain = false
  private _initialRefresh: Promise<void> | null = null

  constructor(path: string, watcher?: GitWatcher) {
    super()
    this.path = path
    this.queue = new OperationQueue(4)
    this._watcher = watcher ?? createGitWatcher()
  }

  get revision(): number { return this._revision }
  get refCount(): number { return this._refCount }
  get watcherActive(): boolean { return this._watcher.active }
  get watcherIgnored(): boolean { return this._watcherIgnored }
  get snapshot(): RepoSnapshot | null { return this._snapshot }

  retain(): void {
    this._refCount++
    if (this._refCount === 1) {
      const ignoredDirs = readGitWatcherIgnoredDirectories()
      this._watcherIgnored = isPathIgnoredByGitWatcher(this.path, ignoredDirs)
      if (this._watcherIgnored) {
        log(`Git watcher suppressed for ignored path: ${this.path}`)
        // Still register focus-return refresh so the panel updates on window focus.
        focusState.on('change', this._onFocusChange)
      } else {
        log(`Git watcher starting for: ${this.path}`)
        this._watcher.start(this.path, (event) => this.handleWatchEvent(event))
        this._watcher.setSuspended(!focusState.focused)
        focusState.on('change', this._onFocusChange)
      }
      this._initialRefresh = this.refreshSnapshot().catch((err: Error) => {
        log(`Initial snapshot failed for ${this.path}: ${err.message}`)
      })
    }
  }

  release(): boolean {
    this._refCount--
    if (this._refCount <= 0) {
      focusState.off('change', this._onFocusChange)
      this._watcher.stop()
      return true
    }
    return false
  }

  bumpRevision(): void {
    this._revision++
    this.diffCache.clear()
    this.branchCache.clear()
    this.graphCache.clear()
  }

  /** Resolves once the initial retain() snapshot has completed (or immediately if already done). */
  async waitForReady(): Promise<void> {
    if (this._initialRefresh) await this._initialRefresh
  }

  invalidatePath(p: string): void {
    this.diffCache.invalidate((key) => key.startsWith(p + ':'))
  }

  private handleWatchEvent(event: GitWatchEvent): void {
    log(`Watch event ${event.kind} for ${this.path} (revision=${this._revision} refreshing=${this._refreshing})`)
    switch (event.kind) {
      case 'head:changed':
        this.bumpRevision()
        this.refreshSnapshot().catch(() => {})
        break
      case 'status:dirty':
        this.diffCache.clear()
        this._revision++
        this.refreshSnapshot().catch(() => {})
        break
      case 'refs:dirty':
        this.branchCache.clear()
        this.graphCache.clear()
        this._revision++
        this.emitRefsChanged().catch(() => {})
        break
      case 'config:dirty':
        this.branchCache.clear()
        this._revision++
        this.refreshSnapshot().catch(() => {})
        break
    }
    this.emit('watch', event)
  }

  // ─── Snapshot + delta computation ───

  async refreshSnapshot(): Promise<void> {
    if (this._refreshing) { this._refreshAgain = true; return }
    this._refreshing = true
    log(`refreshSnapshot: starting for ${this.path} at revision ${this._revision}`)
    try {
      do {
        this._refreshAgain = false
        const next = await this.computeSnapshot()
        const prev = this._snapshot
        this._snapshot = next

        if (!prev) {
          const totalFiles = next.groups.index.length + next.groups.workingTree.length + next.groups.untracked.length + next.groups.merge.length
          log(`refreshSnapshot: first snapshot revision=${next.revision} files=${totalFiles} head=${next.head.sha?.slice(0, 8) ?? 'null'} for ${this.path}`)
          this.emitEvent({ kind: 'status:changed', repoPath: this.path, revision: next.revision, added: next.groups.index.concat(next.groups.workingTree, next.groups.untracked, next.groups.merge), removed: [], modified: [] })
          this.emitEvent({ kind: 'head:changed', repoPath: this.path, revision: next.revision, head: next.head })
          this.emitEvent({ kind: 'upstream:changed', repoPath: this.path, revision: next.revision, ahead: next.upstream.ahead, behind: next.upstream.behind })
          if (next.mergeState !== 'none') {
            this.emitEvent({ kind: 'merge:changed', repoPath: this.path, revision: next.revision, state: next.mergeState })
          }
        } else {
          const prevAll = [...prev.groups.index, ...prev.groups.workingTree, ...prev.groups.untracked, ...prev.groups.merge]
          const nextAll = [...next.groups.index, ...next.groups.workingTree, ...next.groups.untracked, ...next.groups.merge]
          const { added, removed, modified } = diffFiles(prevAll, nextAll)
          log(`refreshSnapshot: delta revision=${next.revision} prevFiles=${prevAll.length} nextFiles=${nextAll.length} added=${added.length} removed=${removed.length} modified=${modified.length} head=${prev.head.sha?.slice(0, 8) ?? 'null'}->${next.head.sha?.slice(0, 8) ?? 'null'} for ${this.path}`)
          if (added.length || removed.length || modified.length) {
            this.emitEvent({ kind: 'status:changed', repoPath: this.path, revision: next.revision, added, removed, modified })
          } else {
            log(`refreshSnapshot: no status delta at revision ${next.revision} for ${this.path}`)
          }
          if (prev.head.sha !== next.head.sha || prev.head.branch !== next.head.branch || prev.head.detached !== next.head.detached) {
            this.emitEvent({ kind: 'head:changed', repoPath: this.path, revision: next.revision, head: next.head })
          }
          if (prev.upstream.ahead !== next.upstream.ahead || prev.upstream.behind !== next.upstream.behind || prev.upstream.name !== next.upstream.name) {
            this.emitEvent({ kind: 'upstream:changed', repoPath: this.path, revision: next.revision, ahead: next.upstream.ahead, behind: next.upstream.behind })
          }
          if (prev.mergeState !== next.mergeState) {
            this.emitEvent({ kind: 'merge:changed', repoPath: this.path, revision: next.revision, state: next.mergeState })
          }
        }
      } while (this._refreshAgain)
    } finally {
      this._refreshing = false
      log(`refreshSnapshot: done for ${this.path} at revision ${this._revision}`)
    }
  }

  private async computeSnapshot(): Promise<RepoSnapshot> {
    const empty: RepoSnapshot = {
      repoPath: this.path,
      isGitRepo: false,
      head: { branch: null, detached: false, sha: null },
      upstream: { name: null, ahead: 0, behind: 0 },
      mergeState: 'none',
      groups: { index: [], workingTree: [], untracked: [], merge: [] },
      revision: this._revision,
      watcherIgnored: this._watcherIgnored,
    }
    try {
      await runGit(this.path, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return empty
    }

    let branch: string | null = null
    let sha: string | null = null
    let detached = false
    try {
      branch = (await runGit(this.path, ['branch', '--show-current'])).trim() || null
      sha = (await runGit(this.path, ['rev-parse', 'HEAD'])).trim() || null
      if (!branch && sha) detached = true
    } catch {}

    let ahead = 0, behind = 0
    let upstreamName: string | null = null
    try {
      upstreamName = (await runGit(this.path, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim() || null
    } catch {}
    if (upstreamName) {
      try {
        ahead = parseInt((await runGit(this.path, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
        behind = parseInt((await runGit(this.path, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), 10) || 0
      } catch {}
    }

    let groups: PartitionedStatus = { flat: [], index: [], workingTree: [], untracked: [], merge: [] }
    try {
      const output = await runGit(this.path, ['status', '--porcelain=v1', '-uall'])
      groups = partitionStatus(output)
    } catch {}

    return {
      repoPath: this.path,
      isGitRepo: true,
      head: { branch, detached, sha },
      upstream: { name: upstreamName, ahead, behind },
      mergeState: await this.detectMergeState(),
      groups: { index: groups.index, workingTree: groups.workingTree, untracked: groups.untracked, merge: groups.merge },
      revision: this._revision,
      watcherIgnored: this._watcherIgnored,
    }
  }

  private async detectMergeState(): Promise<MergeState> {
    const { stat } = await import('fs/promises')
    const tryRead = async (p: string): Promise<boolean> => {
      try { await stat(p); return true } catch { return false }
    }
    const join = (await import('path')).join
    const gitDir = join(this.path, '.git')
    if (await tryRead(join(gitDir, 'MERGE_HEAD'))) return 'merging'
    if (await tryRead(join(gitDir, 'rebase-merge')) || await tryRead(join(gitDir, 'rebase-apply'))) return 'rebasing'
    if (await tryRead(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking'
    return 'none'
  }

  private async emitRefsChanged(): Promise<void> {
    // Delta computation against the branch cache is left as a follow-up;
    // for now consumers re-read on this signal.
    this.emitEvent({ kind: 'refs:changed', repoPath: this.path, revision: this._revision, added: [], removed: [], updated: [] })
  }

  private emitEvent(event: GitEvent): void {
    this.emit('event', event)
  }

  // ─── Operation hooks ───

  notifyOpStarted(opId: string, opKind: string): void {
    this.emitEvent({ kind: 'op:started', repoPath: this.path, opId, opKind })
  }

  notifyOpCompleted(opId: string, ok: boolean, durationMs: number, error?: string): void {
    this.emitEvent({ kind: 'op:completed', repoPath: this.path, opId, ok, error, durationMs })
  }

  // ─── Cached reads ───

  async getStatus(): Promise<{ files: StatusEntry[]; branch: string; ahead: number; behind: number; isGitRepo: boolean }> {
    let snap = this._snapshot
    if (!snap) {
      snap = await this.computeSnapshot()
      this._snapshot = snap
    }
    const flat = [...snap.groups.index, ...snap.groups.workingTree, ...snap.groups.untracked, ...snap.groups.merge]
    return {
      files: flat,
      branch: snap.head.branch ?? '',
      ahead: snap.upstream.ahead,
      behind: snap.upstream.behind,
      isGitRepo: snap.isGitRepo,
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
    focusState.off('change', this._onFocusChange)
    this._watcher.stop()
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

export type { HeadInfo, UpstreamInfo, MergeState, RefDelta }
