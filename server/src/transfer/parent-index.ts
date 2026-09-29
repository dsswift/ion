/**
 * transfer/parent-index — which conversation each conversation descends
 * from, and whether it is a fork, for every conversation in a directory.
 *
 * The links are the `parentId` and `forkOf` in a `.llm.jsonl` header. The
 * engine sets `parentId` for a fork, a dispatch child, and a checkpoint cut,
 * and `forkOf` only for a fork; it sets both once, when it creates the
 * conversation, and never rewrites them. So each file's answer is read once
 * and remembered; later scans read only files that are new since the last
 * one.
 *
 * Reading is the cost worth avoiding. A header carries the whole system
 * prompt, so a first line is kilobytes, and a host with tens of thousands
 * of conversations holds hundreds of megabytes of them. Read synchronously
 * at export time, that froze the server for seconds while the transfer
 * dialog sat waiting. Reads here are asynchronous and bounded, and the
 * dialog warms the index when it opens, so the export reads only what is new.
 */
import { open, readdir } from 'fs/promises'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.parent-index'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

const LLM_SUFFIX = '.llm.jsonl'
const READ_CONCURRENCY = 32
const CHUNK_BYTES = 16 * 1024

/** How one conversation is linked to the one it came from. */
export interface ConversationLink {
  /** The conversation it descends from, or null for a root. */
  parentId: string | null
  /** Set only when it is a fork: the conversation it was forked from. */
  forkOf: string | null
}

/** conversationsDir -> (conversation id -> its link). */
const known = new Map<string, Map<string, ConversationLink>>()
/** The last scan queued per directory; scans of one directory run one at a time. */
const queued = new Map<string, Promise<unknown>>()

/** The header line of a `.llm.jsonl`, read up to its first newline only. Throws when there is no newline yet. */
async function readHeaderLine(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const parts: Buffer[] = []
    let position = 0
    for (;;) {
      const buffer = Buffer.alloc(CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position)
      // No newline yet: the header is still being written. Its answer is not
      // known, and remembering one now would be wrong for good.
      if (bytesRead === 0) throw new Error('header line is incomplete')
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
      if (newline !== -1) {
        parts.push(buffer.subarray(0, newline))
        break
      }
      parts.push(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return Buffer.concat(parts).toString('utf-8')
  } finally {
    await handle.close()
  }
}

/** The links in a header line; both null for a root, or a header that does not parse. */
export function linkFromHeader(line: string): ConversationLink {
  try {
    const header = JSON.parse(line) as { parentId?: unknown; forkOf?: unknown }
    return {
      parentId: typeof header.parentId === 'string' && header.parentId ? header.parentId : null,
      forkOf: typeof header.forkOf === 'string' && header.forkOf ? header.forkOf : null,
    }
  } catch {
    // silent-ok: a malformed header only means no discoverable parent link;
    // the conversation still counts as its own family.
    return { parentId: null, forkOf: null }
  }
}

async function scan(conversationsDir: string): Promise<Map<string, ConversationLink>> {
  const startedAt = Date.now()
  let names: string[]
  try {
    names = await readdir(conversationsDir)
  } catch (err) {
    warn('conversations directory unreadable; no parent links', { conversations_dir: conversationsDir, error: String(err) })
    return new Map()
  }
  const ids = names.filter((n) => n.endsWith(LLM_SUFFIX)).map((n) => n.slice(0, -LLM_SUFFIX.length))
  const index = known.get(conversationsDir) ?? new Map<string, ConversationLink>()
  const present = new Set(ids)
  let pruned = 0
  for (const id of index.keys()) {
    if (!present.has(id)) { index.delete(id); pruned++ }
  }
  const unread = ids.filter((id) => !index.has(id))
  let failed = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < unread.length) {
      const id = unread[next++]
      try {
        index.set(id, linkFromHeader(await readHeaderLine(join(conversationsDir, `${id}${LLM_SUFFIX}`))))
      } catch {
        // Unreadable now (header mid-write, or just deleted): not remembered, so the
        // next scan tries it again rather than caching a wrong answer.
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, unread.length) }, worker))
  known.set(conversationsDir, index)
  log('scanned', { conversations_dir: conversationsDir, conversation_count: ids.length, newly_read: unread.length - failed, unreadable: failed, pruned, elapsed_ms: Date.now() - startedAt })
  return index
}

/**
 * Every conversation's links in `conversationsDir`, current as of this
 * call: files added since the last scan are read, files gone are dropped.
 */
export function parentIndex(conversationsDir: string): Promise<Map<string, ConversationLink>> {
  // Queued behind any scan already running, never shared with it: that scan
  // listed the directory before this call, and a conversation forked since
  // would be missing from its answer. Once warm, a scan reads only new files.
  const prior = queued.get(conversationsDir) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(() => scan(conversationsDir)) // silent-ok: scan logs its own failures
  queued.set(conversationsDir, run)
  return run
}

/** Start a scan without waiting for it, so a later export finds the index warm. */
export function warmParentIndex(conversationsDir: string): void {
  void parentIndex(conversationsDir)
}

export function _resetParentIndexForTest(): void {
  known.clear()
  queued.clear()
}
