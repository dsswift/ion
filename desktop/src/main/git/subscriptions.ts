/**
 * Bridges GitRepository event emissions to subscribed renderer windows.
 *
 * Each renderer subscribes by repo path; main retains the repo and starts
 * forwarding `event` emissions to the renderer's webContents over GIT_EVENT.
 * On unsubscribe (or webContents destroy), the repo is released.
 */

import type { WebContents } from 'electron'
import { repositoryManager } from './repositoryManager'
import type { GitRepository } from './repository'
import type { GitEvent, RepoSnapshot } from '../../shared/types-git-events'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'

function log(msg: string): void { _log('main', msg) }

interface Subscription {
  repo: GitRepository
  webContents: WebContents
  listener: (event: GitEvent) => void
  destroyListener: () => void
}

const subscriptions = new Map<string, Subscription>()

function keyFor(webContentsId: number, repoPath: string): string {
  return `${webContentsId}::${repoPath}`
}

export async function subscribe(webContents: WebContents, repoPath: string): Promise<RepoSnapshot | null> {
  const key = keyFor(webContents.id, repoPath)
  if (subscriptions.has(key)) {
    return subscriptions.get(key)!.repo.snapshot
  }

  const repo = repositoryManager.retain(repoPath)

  const listener = (event: GitEvent): void => {
    if (webContents.isDestroyed()) return
    webContents.send(IPC.GIT_EVENT, event)
  }
  const destroyListener = (): void => { unsubscribe(webContents, repoPath) }

  repo.on('event', listener)
  webContents.once('destroyed', destroyListener)

  subscriptions.set(key, { repo, webContents, listener, destroyListener })
  log(`Git subscribed wc=${webContents.id} repo=${repoPath}`)

  // Wait for the initial retain() refresh to complete so we return a real
  // snapshot rather than null. If retain() was already done this resolves
  // immediately. The fallback refreshSnapshot() below handles the edge case
  // where retain() itself failed.
  await repo.waitForReady()

  if (!repo.snapshot) {
    log(`Git subscribe: no snapshot after waitForReady for ${repoPath}, forcing refresh`)
    await repo.refreshSnapshot().catch((err: Error) => log(`refreshSnapshot failed: ${err.message}`))
  }
  log(`Git subscribe: returning snapshot revision=${repo.snapshot?.revision ?? 'null'} for ${repoPath}`)
  return repo.snapshot
}

export function unsubscribe(webContents: WebContents, repoPath: string): void {
  const key = keyFor(webContents.id, repoPath)
  const sub = subscriptions.get(key)
  if (!sub) return
  sub.repo.off('event', sub.listener)
  if (!webContents.isDestroyed()) {
    webContents.removeListener('destroyed', sub.destroyListener)
  }
  subscriptions.delete(key)
  repositoryManager.release(repoPath)
  log(`Git unsubscribed wc=${webContents.id} repo=${repoPath}`)
}

export function unsubscribeAll(webContents: WebContents): void {
  for (const [key, sub] of subscriptions) {
    if (sub.webContents.id === webContents.id) {
      sub.repo.off('event', sub.listener)
      subscriptions.delete(key)
      repositoryManager.release(sub.repo.path)
    }
  }
}
