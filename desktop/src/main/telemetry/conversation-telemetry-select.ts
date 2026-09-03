/**
 * Conversation Telemetry selection — which conversations a call covers.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A registered worktree is a work boundary: everything done in it belongs to
 * one piece of work, and a retro that saw only the conversation it happens to
 * be running in would see a fraction of it. A plain directory is NOT a work
 * boundary — adjacent conversations there may belong to any project — so
 * outside a worktree the selection refuses to widen and covers the calling
 * conversation and the chain it was cleared and continued from.
 *
 * ── Why the sweep reads every header ────────────────────────────────────────
 * Membership is decided by the one fact that settles it: every tree header
 * records the session's `workingDirectory`. Nothing cheaper is exact.
 *
 * The obvious optimisation — skip files last written before the worktree's
 * registered `createdAt` — looks provably safe and is not. Two cases break it,
 * and both exist in real registries: a registry entry can name a directory
 * that predates its registration (a plain checkout registered as work), and
 * re-registering an existing worktree stamps a fresh `createdAt`. Either one
 * makes the prune drop real members, silently, with no way for the caller to
 * notice. Reading every header costs a few seconds against a hundred thousand
 * files, which is inside the client-tool bound and is what correctness costs.
 *
 * ── Why the result is capped ────────────────────────────────────────────────
 * A long-lived checkout accumulates thousands of conversations, and measuring
 * all of them would return a payload no context window can hold. The most
 * recently active are the ones a retro is about, so the cap keeps those and
 * the selection reports both the cap and the full match count. A dropped
 * conversation is stated, never silent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'
import { loadRegistry, type RegistryEntry } from '../worktree/registry'
import { readTreeHeader, type ScanPaths } from './conversation-telemetry-scan'

const TAG = 'telemetry.select'

const TREE_SUFFIX = '.tree.jsonl'

export function conversationsDir(): string {
  return join(homedir(), '.ion', 'conversations')
}

/**
 * Most recently active conversations a single call measures.
 *
 * Sized so the payload stays inside a working context window even when every
 * conversation is a long one. A worktree cut for one piece of work is far
 * below it; only a long-lived checkout reaches it.
 */
export const MAX_CONVERSATIONS = 40

export interface Selection {
  scope: 'self' | 'worktree'
  worktree?: RegistryEntry
  /** Conversation ids to scan, oldest first. */
  conversationIds: string[]
  /** How many conversations matched before the cap was applied. */
  matchedCount: number
  /** True when the cap dropped matches, so the caller can say so. */
  truncated: boolean
}

/**
 * The registry entry whose worktree contains `cwd`, or null.
 *
 * Matches the worktree root itself and any path beneath it, so a conversation
 * working in a subdirectory of a worktree is still inside it. A landed
 * worktree still matches: its conversations are exactly the record a retro
 * wants to read.
 */
export function worktreeForCwd(cwd: string, registry: RegistryEntry[] = loadRegistry()): RegistryEntry | null {
  if (!cwd) return null
  let best: RegistryEntry | null = null
  for (const entry of registry) {
    const root = entry.worktreePath
    if (!root) continue
    if (cwd !== root && !cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
    // Longest match wins, so a worktree nested inside another resolves to the
    // inner one rather than to whichever the registry happened to list first.
    if (!best || root.length > best.worktreePath.length) best = entry
  }
  return best
}

/**
 * Conversations whose tree header names `worktreePath` as their working
 * directory, most-recently-active first through the cap and oldest first on
 * the way out. Reports the full match count alongside the kept ids so a
 * truncation is stated rather than silent.
 */
export function conversationsInWorktree(
  worktree: RegistryEntry,
  paths: ScanPaths,
): { ids: string[]; matchedCount: number } {
  let names: string[]
  try {
    names = readdirSync(paths.conversationsDir)
  } catch (err) {
    _warn(TAG, 'conversations directory unreadable', { dir: paths.conversationsDir, error: String(err) })
    return { ids: [], matchedCount: 0 }
  }

  const started = Date.now()
  const members: Array<{ id: string; lastWriteMs: number }> = []
  let treesSeen = 0
  for (const name of names) {
    if (!name.endsWith(TREE_SUFFIX)) continue
    treesSeen += 1
    const id = name.slice(0, -TREE_SUFFIX.length)
    const header = readTreeHeader(id, paths)
    if (header?.workingDirectory !== worktree.worktreePath) continue
    let lastWriteMs = 0
    try {
      lastWriteMs = statSync(join(paths.conversationsDir, name)).mtimeMs
    } catch {
      // Deleted between readdir and stat. It still matched, so keep it and let
      // the scan report it missing rather than dropping it here unremarked.
      lastWriteMs = 0
    }
    members.push({ id, lastWriteMs })
  }

  // Newest activity first for the cap, then oldest first for the caller, so a
  // spec → implement → refine progression reads in order.
  members.sort((a, b) => b.lastWriteMs - a.lastWriteMs)
  const kept = members.slice(0, MAX_CONVERSATIONS)
  kept.sort((a, b) => a.id.localeCompare(b.id))

  _log(TAG, 'worktree conversation sweep complete', {
    worktree: worktree.worktreePath,
    trees_seen: treesSeen,
    matched: members.length,
    kept: kept.length,
    latency_ms: Date.now() - started,
  })
  return { ids: kept.map((member) => member.id), matchedCount: members.length }
}

/**
 * Walk the parentId chain from a conversation back to its oldest ancestor.
 *
 * A /clear that continues into a fresh conversation records the previous one as
 * its parent, so this is what reassembles a cleared-and-continued piece of work
 * outside a worktree. Bounded by a visited set: a corrupt parent cycle must not
 * spin.
 */
export function selfChain(conversationId: string, paths: ScanPaths): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = conversationId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    chain.push(cursor)
    cursor = parentOf(cursor, paths)
  }
  return chain.reverse()
}

function parentOf(conversationId: string, paths: ScanPaths): string | undefined {
  try {
    const file = join(paths.conversationsDir, `${conversationId}.llm.jsonl`)
    if (!existsSync(file)) return undefined
    const buffer = readFileSync(file)
    const newline = buffer.indexOf(0x0a)
    const header = JSON.parse(
      buffer.subarray(0, newline === -1 ? buffer.length : newline).toString('utf-8'),
    ) as { parentId?: unknown }
    return typeof header.parentId === 'string' && header.parentId ? header.parentId : undefined
  } catch (err) {
    _warn(TAG, 'parent link unreadable', { conversation_id: conversationId, error: String(err) })
    return undefined
  }
}

/**
 * Resolve the full selection for one call.
 *
 * `cwd` decides the scope and `conversationId` names the caller. The registry
 * defaults to the live one and is injectable so a test can describe a worktree
 * without writing into the operator's own `~/.ion`.
 *
 * A worktree cwd
 * whose sweep finds nothing still reports worktree scope with the calling
 * chain: an empty list would read as "this worktree has no work", which is
 * never true of a worktree someone is running a retro in.
 */
export function selectConversations(
  cwd: string,
  conversationId: string,
  paths: ScanPaths,
  registry: RegistryEntry[] = loadRegistry(),
): Selection {
  const worktree = worktreeForCwd(cwd, registry)
  if (!worktree) {
    const chain = selfChain(conversationId, paths)
    _log(TAG, 'self-scoped selection', { cwd, conversation_id: conversationId, chain: chain.length })
    return { scope: 'self', conversationIds: chain, matchedCount: chain.length, truncated: false }
  }
  const { ids, matchedCount } = conversationsInWorktree(worktree, paths)
  if (ids.length > 0) {
    return { scope: 'worktree', worktree, conversationIds: ids, matchedCount, truncated: matchedCount > ids.length }
  }
  const chain = selfChain(conversationId, paths)
  return { scope: 'worktree', worktree, conversationIds: chain, matchedCount: chain.length, truncated: false }
}
