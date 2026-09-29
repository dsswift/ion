/**
 * transfer/references — every file outside a conversation's own folders that
 * its history points at, so a transfer can carry it along.
 *
 * A conversation's own files ship whole: `<id>/` (plans, attachments,
 * images), `tool-results/<id>/`, and its charts. What this finds is the rest:
 * a plan kept in a shared folder, a file attached from the shared
 * attachment store or from anywhere on disk, and spilled tool output that a
 * fork made before forks owned their files still points at in its parent's
 * folder. Each is named in the history by absolute path, in one of these
 * forms:
 *
 *   - a `planFilePath` field (plan markers, plan-mode state, a denied
 *     ExitPlanMode's input) and a plan-writing tool's `file_path`/`path`;
 *   - an `[Attached image|file|plan: <path>]` line in a prompt;
 *   - an `attachments: [{type, path}]` entry on a message;
 *   - `Full output saved to: <path> — ` in a truncated tool result.
 *
 * The same regexes the Attachments panel uses are shared from
 * `tab-attachment-scan.ts`, so the transfer carries exactly what the panel
 * lists.
 */
import { readFileSync, statSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import { ATTACHMENT_LINE_RE, PLAN_PATH_RE } from '../remote/handlers/tab-attachment-scan'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.references'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type ReferenceKind = 'plan' | 'file' | 'image' | 'tool-result'

/** One file a history points at, and the conversation whose history named it. */
export interface Reference {
  path: string
  kind: ReferenceKind
  /** The family member that owns the reference on the destination. */
  ownerId: string
}

const PATH_KEYS = new Set(['planFilePath', 'file_path', 'path', 'filePath'])
const TOOL_RESULT_RE = /Full output saved to: (.+?) — /g
const ATTACHMENT_TYPES = new Set(['image', 'file', 'plan'])

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Collects references from one parsed JSON value. */
function walk(value: unknown, ownerId: string, add: (ref: Reference) => void, key?: string): void {
  if (typeof value === 'string') {
    if (key && PATH_KEYS.has(key) && isAbsolute(value) && PLAN_PATH_RE.test(value)) add({ path: value, kind: 'plan', ownerId })
    for (const line of value.split('\n')) {
      const m = ATTACHMENT_LINE_RE.exec(line.trim())
      if (m && isAbsolute(m[2])) add({ path: m[2], kind: m[1] as ReferenceKind, ownerId })
    }
    for (const m of value.matchAll(TOOL_RESULT_RE)) {
      if (isAbsolute(m[1])) add({ path: m[1], kind: 'tool-result', ownerId })
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, ownerId, add)
    return
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.type === 'string' && ATTACHMENT_TYPES.has(record.type) && typeof record.path === 'string' && isAbsolute(record.path)) {
      add({ path: record.path, kind: record.type as ReferenceKind, ownerId })
    }
    for (const [k, v] of Object.entries(record)) walk(v, ownerId, add, k)
  }
}

/** Collects references from JSONL text, one parsed line at a time. */
function walkJsonl(text: string, ownerId: string, add: (ref: Reference) => void): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      walk(JSON.parse(line), ownerId, add)
    } catch {
      // silent-ok: a line that is not JSON (a torn final write) names no
      // path the engine could still resolve; the rest of the file is read.
    }
  }
}

export interface CollectArgs {
  conversationsDir: string
  /** Each family member's conversation files (already planned for the archive). */
  members: ReadonlyArray<{ id: string; paths: readonly string[] }>
  rootConversationId: string
  /** The tab record and tab content, which carry their own copies of paths. */
  tabData: unknown[]
}

/**
 * Every file outside the family's own folders that the family's history, tab
 * record, or tab content names. A path inside a member's own folder or its
 * `tool-results/<id>/` is left out: those folders ship whole. A path that no
 * longer exists is reported as missing and left as it is in the history.
 */
export function collectReferences(args: CollectArgs): { references: Reference[]; missing: string[] } {
  const found = new Map<string, Reference>()
  const add = (ref: Reference): void => { if (!found.has(ref.path)) found.set(ref.path, ref) }

  for (const member of args.members) {
    for (const path of member.paths) {
      if (!path.endsWith('.jsonl') && !path.endsWith('.json')) continue
      try {
        walkJsonl(readFileSync(path, 'utf-8'), member.id, add)
      } catch (err) {
        warn('conversation file unreadable; its references are not carried', { path, error: String(err) })
      }
    }
  }
  for (const data of args.tabData) walk(data, args.rootConversationId, add)

  const owned = args.members.flatMap((m) => [join(args.conversationsDir, m.id), join(args.conversationsDir, 'tool-results', m.id)])
  const references: Reference[] = []
  const missing: string[] = []
  for (const ref of found.values()) {
    if (owned.some((root) => isWithin(root, ref.path))) continue
    let isFile = false
    try { isFile = statSync(ref.path).isFile() } catch { /* silent-ok: missing is reported below */ }
    if (!isFile) {
      missing.push(ref.path)
      continue
    }
    references.push(ref)
  }
  log('references collected', {
    root_conversation_id: args.rootConversationId,
    count: references.length,
    missing: missing.length,
    plans: references.filter((r) => r.kind === 'plan').length,
    files: references.filter((r) => r.kind === 'file' || r.kind === 'image').length,
    tool_results: references.filter((r) => r.kind === 'tool-result').length,
  })
  if (missing.length > 0) warn('referenced files no longer exist; their paths are left as they are', { root_conversation_id: args.rootConversationId, missing: missing.join(',') })
  return { references, missing }
}

/**
 * Whether a referenced file belongs to the conversation's history alone and
 * is deleted from the source once the move completes. Only a plan in a shared
 * plans folder is: the conversation edits it, so a copy left behind would go
 * stale and collide when the conversation comes back. Attached files are
 * the user's own or live in the content-named shared store, and are kept.
 */
export function isMovedWithConversation(ref: Pick<Reference, 'kind'>): boolean {
  return ref.kind === 'plan'
}

/** Whether `path` is `root` or lies under it. */
export const pathWithin = isWithin
