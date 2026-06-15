// ion_read_conversation tool -- read a conversation transcript by ID.
//
// Reads from `~/.ion/conversations/<id>.tree.jsonl` (default) or
// `<id>.llm.jsonl`. Supports pagination via `offset`/`limit`,
// role-filtering, and a cheap `summary` mode that only reads the meta
// line without streaming all messages.
//
// File format (engine/internal/conversation/persistence.go):
//   Line 0 (all variants): JSON meta object. Fields differ by variant:
//     tree.jsonl: { id, leafId, meta:true, version, workingDirectory }
//     llm.jsonl:  { id, meta:true, model, createdAt, ... }
//   Lines 1+:
//     tree.jsonl: { id, parentId, type:"message", timestamp, data:{role, content[]} }
//     llm.jsonl:  { role, content[] }   (no id/timestamp)
//
// I/O design:
//   All reads go through a single readline stream per invocation. Meta
//   (line 0) is extracted from the first line of that stream. Summary mode
//   closes the stream after recording the count and first user message;
//   it never loads the whole file. readFileSync is never used for the
//   main conversation file.
//
// Path safety: ID is validated against a strict allow-list before any
// filesystem access. No caller-controlled path segments reach the OS.

import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ToolDef } from '../../sdk/ion-sdk'
import {
  validateConversationId,
  conversationFilePath,
  conversationsDir,
} from './conversation-utils'

// ─── Parameter types ──────────────────────────────────────────────────────

interface ReadConversationParams {
  /** Conversation/session ID (e.g. `1781440740558-4a286b13f53d`). */
  id: string
  /** Which file variant to read. Default `"tree"` (has timestamps + message tree).
   *  Use `"llm"` for the raw LLM replay transcript. */
  source?: 'tree' | 'llm'
  /** 0-based message index to start from (after the meta line). Default 0. */
  offset?: number
  /** Max messages to return. Default 20. Capped at 50. */
  limit?: number
  /** Filter to only messages of this role. */
  role?: 'user' | 'assistant'
  /** When true, return only meta + message count + first user message preview.
   *  A single streaming pass reads line 0 (meta), counts lines, and finds the
   *  first user message — it never loads the whole file into memory. */
  summary?: boolean
}

// ─── Result types ─────────────────────────────────────────────────────────

interface MessageEntry {
  index: number
  /** Present on tree.jsonl messages. */
  id?: string
  parentId?: string | null
  role: string
  /** Unix epoch ms. Present on tree.jsonl messages; absent on llm.jsonl. */
  timestamp?: number
  /** First 2000 chars of the concatenated text blocks in content. */
  contentPreview: string
  /** Total character count across all text blocks (before truncation). */
  contentLength: number
}

interface ReadConversationResult {
  id: string
  source: 'tree' | 'llm'
  /** Absolute path of the file that was read. */
  filePath: string
  meta: Record<string, unknown>
  /** Total message lines (excluding meta line 0). Populated in summary mode
   *  and when the full file is consumed. Null when pagination stops early. */
  totalMessages: number | null
  returnedMessages: number
  offset: number
  hasMore: boolean
  messages: MessageEntry[]
  /** Content of the .memory.md file if it exists for this conversation. */
  memory?: string
}

// ─── Content extraction ───────────────────────────────────────────────────

const CONTENT_PREVIEW_LIMIT = 2000

/** Extract human-readable text from a content block array. */
function extractText(content: unknown): { preview: string; length: number } {
  if (!Array.isArray(content)) return { preview: '', length: 0 }

  let full = ''
  for (const block of content) {
    if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string') {
      full += (block as { text: string }).text
    }
  }
  return {
    preview: full.slice(0, CONTENT_PREVIEW_LIMIT),
    length: full.length,
  }
}

/** Parse one JSON line from a tree.jsonl message (type === "message"). */
function parseTreeMessage(raw: string, index: number): MessageEntry | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  if (!obj.type || obj.type !== 'message') return null

  const data = obj.data as Record<string, unknown> | undefined
  if (!data) return null

  const role = typeof data.role === 'string' ? data.role : 'unknown'
  const { preview, length } = extractText(data.content)

  return {
    index,
    id: typeof obj.id === 'string' ? obj.id : undefined,
    parentId: obj.parentId !== undefined ? obj.parentId as string | null : undefined,
    role,
    timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
    contentPreview: preview,
    contentLength: length,
  }
}

/** Parse one JSON line from a llm.jsonl message (has role/content at top level). */
function parseLlmMessage(raw: string, index: number): MessageEntry | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  // Meta line has no `role` field.
  if (typeof obj.role !== 'string') return null

  const { preview, length } = extractText(obj.content)
  return {
    index,
    role: obj.role,
    contentPreview: preview,
    contentLength: length,
  }
}

// ─── Core reader ─────────────────────────────────────────────────────────

interface StreamResult {
  /** Line 0 parsed as the meta object. */
  meta: Record<string, unknown>
  /** Populated in summary mode: total message lines (excluding meta). */
  totalMessages: number | null
  /** Populated in summary mode: first user message text (≤2000 chars). */
  firstUserMessage: string | null
  /** Populated in paginated mode: matched messages. */
  messages: MessageEntry[]
  hasMore: boolean
}

/**
 * Single-pass readline stream over a conversation file.
 *
 * Line 0: parsed as the meta object (always).
 * Lines 1+:
 *   summary=true  — count all message lines; find the first user message;
 *                   never store content. Stream runs to EOF.
 *   summary=false — apply offset/limit/role filters; collect up to `limit`
 *                   messages; close stream early once satisfied.
 *
 * readFileSync is never called for the conversation file itself.
 */
async function streamFile(
  filePath: string,
  source: 'tree' | 'llm',
  summary: boolean,
  offset: number,
  limit: number,
  roleFilter: string | undefined,
): Promise<StreamResult> {
  const result: StreamResult = {
    meta: {},
    totalMessages: null,
    firstUserMessage: null,
    messages: [],
    hasMore: false,
  }

  let lineIndex = -1  // incremented before use; 0 = meta line
  let msgIndex = -1   // counts parsed message lines (non-meta)
  let msgCount = 0    // for summary mode: total message lines seen
  let firstUserFound = false

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      if (!line.trim()) return
      lineIndex++

      // ── Line 0: meta ─────────────────────────────────────────────────
      if (lineIndex === 0) {
        try { result.meta = JSON.parse(line) } catch { /* leave as {} */ }
        return
      }

      // ── Lines 1+: messages ───────────────────────────────────────────
      if (summary) {
        // Count every non-empty line after the meta as a message line.
        msgCount++

        // Find the first user message without storing any content.
        if (!firstUserFound) {
          const parsed = source === 'tree'
            ? parseTreeMessage(line, 0)
            : parseLlmMessage(line, 0)
          if (parsed !== null && parsed.role === 'user') {
            result.firstUserMessage = parsed.contentPreview
            firstUserFound = true
          }
        }
        return
      }

      // Paginated mode: parse and filter.
      const parsed = source === 'tree'
        ? parseTreeMessage(line, msgIndex + 1)
        : parseLlmMessage(line, msgIndex + 1)

      if (parsed === null) return

      msgIndex++

      if (roleFilter && parsed.role !== roleFilter) return
      if (msgIndex < offset) return

      if (result.messages.length >= limit) {
        result.hasMore = true
        rl.close()
        return
      }

      result.messages.push(parsed)
    })

    rl.on('close', () => {
      if (summary) result.totalMessages = msgCount
      resolve()
    })
    rl.on('error', reject)
  })

  return result
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function readConversation(
  params: ReadConversationParams,
): Promise<{ content: string; isError?: boolean }> {
  // Validate ID.
  const idCheck = validateConversationId(params.id)
  if (!idCheck.valid) {
    return { content: idCheck.error!, isError: true }
  }

  const source = params.source ?? 'tree'
  const offset = Math.max(0, params.offset ?? 0)
  const limit = Math.min(50, Math.max(1, params.limit ?? 20))
  const roleFilter = params.role
  const summaryMode = params.summary === true

  // Resolve the target file. Prefer the requested source; fall back to
  // legacy .jsonl when .tree.jsonl is missing (older conversations).
  let filePath = conversationFilePath(params.id, source)
  if (!existsSync(filePath) && source === 'tree') {
    const legacy = conversationFilePath(params.id, 'legacy')
    if (existsSync(legacy)) {
      filePath = legacy
    }
  }

  if (!existsSync(filePath)) {
    const dir = conversationsDir()
    return {
      content: JSON.stringify({
        error: `No conversation file found for id ${JSON.stringify(params.id)}`,
        tried: [filePath],
        hint: `Conversations live at ${dir}. Use ion_list_conversations to find valid IDs.`,
      }, null, 2),
      isError: true,
    }
  }

  // Single streaming pass: yields meta + whatever the mode needs.
  let streamed: StreamResult
  try {
    streamed = await streamFile(filePath, source, summaryMode, offset, limit, roleFilter)
  } catch (err) {
    return { content: `Stream error: ${(err as Error).message}`, isError: true }
  }

  // Load memory.md if present (small file — readFileSync is fine here).
  let memory: string | undefined
  const memPath = conversationFilePath(params.id, 'memory')
  if (existsSync(memPath)) {
    try { memory = readFileSync(memPath, 'utf8') } catch { /* non-fatal */ }
  }

  if (summaryMode) {
    const out: Record<string, unknown> = {
      id: params.id,
      source,
      filePath,
      meta: streamed.meta,
      totalMessages: streamed.totalMessages,
      returnedMessages: 0,
      offset: 0,
      hasMore: false,
      messages: [],
    }
    if (streamed.firstUserMessage !== null) out.firstUserMessage = streamed.firstUserMessage
    if (memory !== undefined) out.memory = memory
    return { content: JSON.stringify(out, null, 2) }
  }

  const result: ReadConversationResult = {
    id: params.id,
    source,
    filePath,
    meta: streamed.meta,
    totalMessages: streamed.totalMessages,
    returnedMessages: streamed.messages.length,
    offset,
    hasMore: streamed.hasMore,
    messages: streamed.messages,
    ...(memory !== undefined ? { memory } : {}),
  }

  return { content: JSON.stringify(result, null, 2) }
}

// ─── ToolDef ──────────────────────────────────────────────────────────────

export const readConversationTool: ToolDef = {
  name: 'ion_read_conversation',
  description:
    'Read a conversation transcript by ID from `~/.ion/conversations/`. ' +
    'Supports pagination (offset/limit), role filtering (user/assistant), ' +
    'and a fast summary mode that returns meta + message count without ' +
    'loading all content. Source can be `tree` (timestamped rendering tree, default) ' +
    'or `llm` (raw LLM replay). Also returns the session memory file if present.',
  planModeSafe: true,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Conversation/session ID (e.g. `1781440740558-4a286b13f53d`).',
      },
      source: {
        type: 'string',
        enum: ['tree', 'llm'],
        description: 'File variant to read. `tree` (default) has timestamps and message IDs. `llm` is the raw LLM replay without timestamps.',
      },
      offset: {
        type: 'number',
        description: '0-based message index to start from. Default 0.',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return. Default 20. Capped at 50.',
      },
      role: {
        type: 'string',
        enum: ['user', 'assistant'],
        description: 'Filter to only messages of this role.',
      },
      summary: {
        type: 'boolean',
        description: 'When true, return meta + message count + first user message preview only. One streaming pass, never a full file load.',
      },
    },
    required: ['id'],
  },
  execute: (params: ReadConversationParams) => readConversation(params),
}
