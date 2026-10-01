/**
 * git-subscriptions — repo event subscriptions keyed on an abstract
 * subscriber rather than an Electron `WebContents`.
 *
 * Keying on a window and pushing over `webContents.send` only serves
 * Electron; a browser Studio client's subscriber is a wire connection. The
 * identity is the ONLY thing that differs — retain/release bookkeeping, the
 * one-subscription-per-(subscriber, repo) rule, and the release-on-disappear
 * hook are identical — so the subscriber is a small interface and the
 * bookkeeping lives here once.
 */
import { repositoryManager } from './repositoryManager'
import type { GitRepository } from './repository'
import type { GitEvent, RepoSnapshot } from '@ion/shared/types-git-events'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('git-subscriptions', msg, fields) }

/** Whoever is listening: a wire connection, or an Electron window. */
export interface GitSubscriber {
  /** Stable for the life of the subscriber; scopes the subscription key. */
  id: string
  send: (event: GitEvent) => void
}

interface Subscription {
  repo: GitRepository
  listener: (event: GitEvent) => void
}

const subscriptions = new Map<string, Subscription>()

function keyFor(subscriberId: string, repoPath: string): string {
  return `${subscriberId}::${repoPath}`
}

/**
 * Subscribe `subscriber` to `repoPath`, returning the repository's snapshot.
 * Idempotent per pair.
 *
 * Resolves only after the repository's first read has finished. A freshly
 * retained repository has no snapshot yet, and that read lands as deltas
 * that never carry `isGitRepo`, so answering early left the subscriber
 * believing the directory was not a repository.
 */
export async function subscribeGit(subscriber: GitSubscriber, repoPath: string): Promise<RepoSnapshot | null> {
  const key = keyFor(subscriber.id, repoPath)
  const existing = subscriptions.get(key)
  if (existing) {
    await existing.repo.waitForReady()
    return existing.repo.snapshot
  }

  const repo = repositoryManager.retain(repoPath)
  const listener = (event: GitEvent): void => subscriber.send(event)
  repo.on('event', listener)
  subscriptions.set(key, { repo, listener })
  await repo.waitForReady()
  const snapshot = repo.snapshot
  log('subscribed', { subscriber: subscriber.id, path: repoPath, has_snapshot: snapshot !== null, is_git_repo: snapshot?.isGitRepo ?? null })
  return snapshot
}

export function unsubscribeGit(subscriberId: string, repoPath: string): void {
  const key = keyFor(subscriberId, repoPath)
  const sub = subscriptions.get(key)
  if (!sub) return
  sub.repo.off('event', sub.listener)
  subscriptions.delete(key)
  repositoryManager.release(repoPath)
  log('unsubscribed', { subscriber: subscriberId, path: repoPath })
}

/**
 * Drop every subscription a subscriber holds. Called when a connection
 * closes: without it each dropped client would leak a retained repository
 * and its file watcher for the lifetime of the process.
 */
export function unsubscribeGitAll(subscriberId: string): void {
  const prefix = `${subscriberId}::`
  let dropped = 0
  for (const key of [...subscriptions.keys()]) {
    if (!key.startsWith(prefix)) continue
    unsubscribeGit(subscriberId, key.slice(prefix.length))
    dropped++
  }
  if (dropped > 0) log('subscriber gone; released its repos', { subscriber: subscriberId, count: dropped })
}
