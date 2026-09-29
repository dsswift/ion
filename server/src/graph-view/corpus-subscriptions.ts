/**
 * Per-subscriber accounting over `corpus-store.ts`'s reference counts.
 *
 * `subscribeCorpus` / `unsubscribeCorpus` count references and nothing
 * else: they do not know who took a reference. That was fine while the
 * only caller was one Electron window whose lifetime was the process's.
 * Over the Studio wire a subscriber is a connection, and a connection can
 * drop mid-session with its references still held -- a leaked reference
 * keeps a directory scan warm and a file watcher running for the life of
 * the server. This module records which connection holds how many
 * references to which project, so `unsubscribeCorpusAll` can hand every
 * one of them back when the socket closes (the same shape as
 * `git/git-subscriptions.ts`'s `unsubscribeGitAll`).
 */
import type { CorpusSnapshot } from '@ion/shared/graph-corpus-types'
import { subscribeCorpus, unsubscribeCorpus } from './corpus-store'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('graph-corpus-subscriptions', msg, fields)
}

/** `${subscriberId}::${projectPath}` → references this subscriber holds. */
const held = new Map<string, number>()

function key(subscriberId: string, projectPath: string): string {
  return `${subscriberId}::${projectPath}`
}

/** Take one reference on `projectPath`'s corpus for `subscriberId`. */
export async function subscribeCorpusFor(subscriberId: string, projectPath: string): Promise<CorpusSnapshot> {
  const snapshot = await subscribeCorpus(projectPath)
  const k = key(subscriberId, projectPath)
  held.set(k, (held.get(k) ?? 0) + 1)
  return snapshot
}

/**
 * Release one of `subscriberId`'s references on `projectPath`. A release
 * with nothing held is a no-op rather than a decrement of someone else's
 * count: the store's own refcount belongs to whoever took it.
 */
export function unsubscribeCorpusFor(subscriberId: string, projectPath: string): void {
  const k = key(subscriberId, projectPath)
  const count = held.get(k) ?? 0
  if (count <= 0) {
    log('release ignored: subscriber holds no reference', { subscriber: subscriberId, project_path: projectPath })
    return
  }
  if (count === 1) held.delete(k)
  else held.set(k, count - 1)
  unsubscribeCorpus(projectPath)
}

/** Release every reference `subscriberId` still holds. Called when its connection closes. */
export function unsubscribeCorpusAll(subscriberId: string): void {
  const prefix = `${subscriberId}::`
  let dropped = 0
  for (const [k, count] of [...held.entries()]) {
    if (!k.startsWith(prefix)) continue
    const projectPath = k.slice(prefix.length)
    for (let i = 0; i < count; i++) unsubscribeCorpus(projectPath)
    held.delete(k)
    dropped += count
  }
  if (dropped > 0) log('subscriber gone; released its corpus references', { subscriber: subscriberId, count: dropped })
}

/** TEST ONLY: the references a subscriber holds on a project. */
export function heldCorpusReferencesForTest(subscriberId: string, projectPath: string): number {
  return held.get(key(subscriberId, projectPath)) ?? 0
}

/** TEST ONLY. */
export function _resetCorpusSubscriptionsForTest(): void {
  held.clear()
}
