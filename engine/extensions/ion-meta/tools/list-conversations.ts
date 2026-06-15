// ion_list_conversations tool -- enumerate and search conversations.
//
// Lists conversations from `~/.ion/conversations/` with filtering by
// time range, working directory, model, or first-message content.
//
// Design constraints (29,000+ files in the directory):
//   - Never bulk-loads the directory into memory in one shot.
//   - Two-pass strategy:
//       Pass 1: readdirSync once, parse timestamps from filenames, apply
//               before/after filter, sort newest-first, take candidate
//               batch (limit * 5 IDs max).
//       Pass 2: open only the candidate meta lines to apply cwd/model/
//               search filters. Stop collecting once `limit` results found.
//   - "search" only looks at the first user message (line 1 of tree.jsonl),
//     keeping I/O proportional to candidate count, not file size.
//   - De-duplicates the four file variants per conversation by base ID.
//
// Path safety: all paths are constructed from the validated conversations
// directory + validated base IDs (allow-list checked in conversation-utils).
// No caller-supplied path reaches the OS.

import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ToolDef } from '../../sdk/ion-sdk'
import {
  conversationsDir,
  conversationFilePath,
  extractTimestampFromId,
  groupFilesByConversationId,
  resolveCreatedAt,
} from './conversation-utils'

// ─── Parameter types ──────────────────────────────────────────────────────

interface ListConversationsParams {
  /** Max results to return. Default 20. Capped at 50. */
  limit?: number
  /** Only conversations created after this ISO date or epoch ms string. */
  after?: string
  /** Only conversations created before this ISO date or epoch ms string. */
  before?: string
  /** Filter to conversations whose workingDirectory starts with this prefix. */
  cwd?: string
  /** Filter by model name (from llm.jsonl meta). Substring match, case-insensitive. */
  model?: string
  /** Search for this text in the first user message. Case-insensitive substring match.
   *  Narrow the candidate set with after/before first for best performance. */
  search?: string
  /** Return format. `compact` (default) returns id+timestamp+wd+model+count.
   *  `full` also includes the first user message preview. */
  format?: 'compact' | 'full'
}

// ─── Result types ─────────────────────────────────────────────────────────

interface ConversationSummary {
  id: string
  createdAt: number | null
  workingDirectory: string | null
  model: string | null
  /** Approximate message count (lines - 1 in tree.jsonl, 0 when file not read). */
  messageCount: number | null
  /** Only present in `full` format or when search is active. */
  firstUserMessage?: string
  /** Which file variants exist for this conversation. */
  variants: string[]
}

interface ListResult {
  conversationsDir: string
  totalScanned: number
  returned: number
  filters: Record<string, unknown>
  conversations: ConversationSummary[]
}

// ─── Timestamp parser for filter params ───────────────────────────────────

function parseFilterTimestamp(value: string): number | null {
  // Try epoch ms (numeric string).
  if (/^\d+$/.test(value)) {
    const n = Number(value)
    return n > 0 ? n : null
  }
  // Try ISO date / datetime.
  const d = new Date(value)
  const t = d.getTime()
  return isNaN(t) ? null : t
}

// ─── Meta line reader ─────────────────────────────────────────────────────

interface MetaFields {
  workingDirectory: string | null
  model: string | null
  messageCount: number | null
}

/**
 * Read the meta line and optionally the first user message of a conversation
 * file using a readline stream that closes as soon as it has what it needs.
 *
 * For compact mode (needFirstMsg=false, needCount=false) this reads only
 * line 0 and then closes the stream — I/O is a few hundred bytes regardless
 * of file size. For full/search mode the stream continues until it finds the
 * first user message, then closes. It never reads the whole file.
 *
 * Model is read from the first line of llm.jsonl (if present) using the same
 * early-close strategy. Returns null if the primary file cannot be read.
 */
async function readConversationMeta(
  id: string,
  needModel: boolean,
  needCount: boolean,
  needFirstMsg: boolean,
  searchText: string | null,
): Promise<{ meta: MetaFields; firstUserMessage: string | null } | null> {
  // Prefer tree.jsonl (has workingDirectory); fall back to legacy .jsonl.
  const treePath = conversationFilePath(id, 'tree')
  const legacyPath = conversationFilePath(id, 'legacy')
  const filePath = existsSync(treePath) ? treePath : existsSync(legacyPath) ? legacyPath : null
  if (!filePath) return null

  const wantFirstMsg = needFirstMsg || searchText !== null
  const wantCount = needCount

  let metaObj: Record<string, unknown> = {}
  let firstUserMessage: string | null = null
  let messageCount = 0
  let metaParsed = false
  let firstUserFound = false

  try {
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })

      let lineIndex = -1

      rl.on('line', (line) => {
        if (!line.trim()) return
        lineIndex++

        if (lineIndex === 0) {
          // Meta line.
          try { metaObj = JSON.parse(line) } catch { /* leave as {} */ }
          metaParsed = true
          // If we need nothing beyond the meta, close immediately.
          if (!wantFirstMsg && !wantCount) {
            rl.close()
          }
          return
        }

        // Lines 1+: message lines.
        if (wantCount) messageCount++

        if (wantFirstMsg && !firstUserFound) {
          // Detect role without a full parse when possible.
          // Tree.jsonl message shape: {"id":"...","parentId":...,"type":"message","timestamp":...,"data":{"role":"user",...}}
          // Llm.jsonl shape: {"role":"user","content":[...]}
          // We do a full parse only for lines that look like they could be user messages.
          let msgObj: Record<string, unknown>
          try { msgObj = JSON.parse(line) } catch { return }

          const data = msgObj.data as Record<string, unknown> | undefined
          const role = data ? data.role : msgObj.role
          if (role !== 'user') return

          const content = data ? data.content : msgObj.content
          if (!Array.isArray(content)) return

          let text = ''
          for (const block of content) {
            if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string') {
              text += (block as { text: string }).text
            }
          }
          firstUserMessage = text.slice(0, 2000)
          firstUserFound = true

          // Done: if we don't need count, we can stop.
          if (!wantCount) {
            rl.close()
          }
        }
      })

      rl.on('close', resolve)
      rl.on('error', reject)
    })
  } catch {
    return null
  }

  if (!metaParsed) return null

  const workingDirectory = typeof metaObj.workingDirectory === 'string'
    ? metaObj.workingDirectory || null
    : null

  // Model: read first line of llm.jsonl using the same early-close strategy.
  let model: string | null = null
  if (needModel) {
    // Fallback: some legacy files embed model in the tree meta.
    if (typeof metaObj.model === 'string') model = metaObj.model

    if (!model) {
      const llmPath = conversationFilePath(id, 'llm')
      if (existsSync(llmPath)) {
        try {
          await new Promise<void>((resolve, reject) => {
            const rl = createInterface({
              input: createReadStream(llmPath, { encoding: 'utf8' }),
              crlfDelay: Infinity,
            })
            rl.on('line', (line) => {
              if (!line.trim()) return
              try {
                const llmMeta = JSON.parse(line)
                if (typeof llmMeta.model === 'string') model = llmMeta.model
              } catch { /* ignore */ }
              rl.close() // only need line 0
            })
            rl.on('close', resolve)
            rl.on('error', reject)
          })
        } catch { /* non-fatal */ }
      }
    }
  }

  return {
    meta: {
      workingDirectory,
      model,
      messageCount: wantCount ? messageCount : null,
    },
    firstUserMessage,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function listConversations(
  params: ListConversationsParams,
): Promise<{ content: string; isError?: boolean }> {
  const limit = Math.min(50, Math.max(1, params.limit ?? 20))
  const format = params.format ?? 'compact'
  const cwdFilter = params.cwd ?? null
  const modelFilter = params.model?.toLowerCase() ?? null
  const searchText = params.search?.toLowerCase() ?? null
  const needModel = modelFilter !== null || format === 'full'
  const needCount = format === 'full'
  const needFirstMsg = format === 'full' || searchText !== null

  let afterMs: number | null = null
  let beforeMs: number | null = null

  if (params.after) {
    afterMs = parseFilterTimestamp(params.after)
    if (afterMs === null) {
      return { content: `Invalid "after" value: ${JSON.stringify(params.after)}`, isError: true }
    }
  }
  if (params.before) {
    beforeMs = parseFilterTimestamp(params.before)
    if (beforeMs === null) {
      return { content: `Invalid "before" value: ${JSON.stringify(params.before)}`, isError: true }
    }
  }

  const dir = conversationsDir()
  if (!existsSync(dir)) {
    return {
      content: JSON.stringify({
        conversationsDir: dir,
        totalScanned: 0,
        returned: 0,
        filters: {},
        conversations: [],
        hint: 'Conversations directory does not exist yet. No conversations have been saved.',
      }, null, 2),
    }
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    return { content: `Failed to read conversations directory: ${(err as Error).message}`, isError: true }
  }

  const grouped = groupFilesByConversationId(entries)
  const totalScanned = grouped.size

  // Extract and filter by timestamp from IDs (fast path, no file I/O).
  interface Candidate { id: string; ts: number | null; variants: string[] }
  const candidates: Candidate[] = []

  for (const [id, files] of grouped) {
    const ts = extractTimestampFromId(id)

    // Timestamp filter (only when we can determine the timestamp from ID).
    // For legacy UUIDs without an embedded timestamp we include them unless
    // both after and before are set (they'd need a file stat to filter,
    // which we defer to pass 2).
    if (ts !== null) {
      if (afterMs !== null && ts < afterMs) continue
      if (beforeMs !== null && ts > beforeMs) continue
    }

    const variantList: string[] = []
    if (files.hasTree) variantList.push('tree.jsonl')
    if (files.hasLlm) variantList.push('llm.jsonl')
    if (files.hasMemory) variantList.push('memory.md')
    if (files.hasLegacy) variantList.push('jsonl')

    candidates.push({ id, ts, variants: variantList })
  }

  // Sort newest-first. Null timestamps go last.
  candidates.sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0
    if (a.ts === null) return 1
    if (b.ts === null) return -1
    return b.ts - a.ts
  })

  // Take a larger candidate batch to allow for filter drop-outs in pass 2.
  // Never exceed 5× the requested limit to keep file I/O bounded.
  const candidateBatch = candidates.slice(0, limit * 5)

  // ── Pass 2: open meta lines, apply cwd/model/search filters ─────────────

  const results: ConversationSummary[] = []

  for (const candidate of candidateBatch) {
    if (results.length >= limit) break

    const read = await readConversationMeta(
      candidate.id,
      needModel,
      needCount,
      needFirstMsg,
      searchText,
    )
    if (!read) continue

    const { meta, firstUserMessage } = read

    // Timestamp filter for legacy UUIDs (stat-based fallback).
    if (candidate.ts === null && (afterMs !== null || beforeMs !== null)) {
      const ts = resolveCreatedAt(candidate.id)
      if (ts !== null) {
        if (afterMs !== null && ts < afterMs) continue
        if (beforeMs !== null && ts > beforeMs) continue
      }
    }

    // cwd filter.
    if (cwdFilter !== null) {
      if (!meta.workingDirectory || !meta.workingDirectory.startsWith(cwdFilter)) continue
    }

    // model filter.
    if (modelFilter !== null) {
      if (!meta.model || !meta.model.toLowerCase().includes(modelFilter)) continue
    }

    // search filter.
    if (searchText !== null) {
      if (!firstUserMessage || !firstUserMessage.toLowerCase().includes(searchText)) continue
    }

    const summary: ConversationSummary = {
      id: candidate.id,
      createdAt: candidate.ts ?? resolveCreatedAt(candidate.id),
      workingDirectory: meta.workingDirectory,
      model: meta.model,
      messageCount: meta.messageCount,
      variants: candidate.variants,
    }
    if (format === 'full' || searchText !== null) {
      summary.firstUserMessage = firstUserMessage ?? undefined
    }

    results.push(summary)
  }

  const result: ListResult = {
    conversationsDir: dir,
    totalScanned,
    returned: results.length,
    filters: {
      ...(afterMs !== null ? { after: new Date(afterMs).toISOString() } : {}),
      ...(beforeMs !== null ? { before: new Date(beforeMs).toISOString() } : {}),
      ...(cwdFilter !== null ? { cwd: cwdFilter } : {}),
      ...(modelFilter !== null ? { model: params.model } : {}),
      ...(searchText !== null ? { search: params.search } : {}),
      format,
      limit,
    },
    conversations: results,
  }

  return { content: JSON.stringify(result, null, 2) }
}

// ─── ToolDef ──────────────────────────────────────────────────────────────

export const listConversationsTool: ToolDef = {
  name: 'ion_list_conversations',
  description:
    'List/search conversations from `~/.ion/conversations/`. Returns newest-first. ' +
    'Filter by time range (after/before), working directory (cwd prefix), model (substring), ' +
    'or first-message content (search). Never bulk-loads the ~29,000-file directory — ' +
    'uses two-pass strategy with bounded I/O. Use `format:"full"` to include first user message previews.',
  planModeSafe: true,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max results to return. Default 20. Capped at 50.',
      },
      after: {
        type: 'string',
        description: 'Only conversations created after this timestamp. ISO date (e.g. `2026-06-14`) or epoch ms string.',
      },
      before: {
        type: 'string',
        description: 'Only conversations created before this timestamp. ISO date or epoch ms string.',
      },
      cwd: {
        type: 'string',
        description: 'Filter to conversations whose workingDirectory starts with this path.',
      },
      model: {
        type: 'string',
        description: 'Filter by model name (substring match, case-insensitive).',
      },
      search: {
        type: 'string',
        description: 'Search for text in the first user message of each conversation. Case-insensitive. Combine with after/before to limit I/O.',
      },
      format: {
        type: 'string',
        enum: ['compact', 'full'],
        description: '`compact` (default): id, timestamp, workingDirectory, model, variants. `full`: adds firstUserMessage preview and messageCount.',
      },
    },
  },
  execute: (params: ListConversationsParams) => listConversations(params),
}
