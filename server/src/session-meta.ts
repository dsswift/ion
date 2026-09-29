import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { stripEngineBridgePrefix } from '@ion/shared/tool-names'
import { log as _log } from './logger'
import { imageAttachmentFromBlock } from './conversation-image-store'
import { principalSubjectForConversation } from './protocol/tabs-index'
import { resolveConversationsDirSync } from './conversation/principal-paths'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export function cleanCliTags(text: string): string {
  let result = text.replace(/<(?:local-command-caveat|system-reminder|command-name|command-message|command-args|task-notification)[^>]*>[\s\S]*?<\/(?:local-command-caveat|system-reminder|command-name|command-message|command-args|task-notification)>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g, '')
  result = result.replace(/<\/?(?:bash-input|bash-stdout|bash-stderr)[^>]*>/g, '')
  return result.trim()
}

/** Returns true if the message was injected by the engine for LLM steering. */
function isInternalMessage(content: string): boolean {
  return content.startsWith('[SYSTEM] ') || content === 'Continue from where you left off.'
}

/**
 * Returns true when a conversation id names a real, resumable conversation on
 * disk — i.e. it has a backing file. Mirrors the engine's conversation.Exists
 * probe order (engine/internal/conversation/persistence.go):
 *
 *   1. <id>.llm.jsonl AND <id>.tree.jsonl both present → split format.
 *   2. <id>.jsonl present → legacy format.
 *   3. <id>.json present → v1 JSON format.
 *
 * A "phantom" id (pre-minted by the engine on a restart and never saved)
 * returns false here. The restore path uses this to skip phantom ids when
 * resolving which conversation a tab should resume, so a fileless trailing id
 * in conversationIds can never be selected and propagated into an empty
 * session. (#230/#231)
 */
export function conversationExists(sessionId: string): boolean {
  if (!sessionId) return false
  const convDir = resolveConversationsDirSync(principalSubjectForConversation(sessionId))

  // Probe 1: split format requires BOTH files (matches the engine, which
  // treats an orphan .llm.jsonl alone as not-a-valid-split).
  const llmPresent = existsSync(join(convDir, `${sessionId}.llm.jsonl`))
  const treePresent = existsSync(join(convDir, `${sessionId}.tree.jsonl`))
  if (llmPresent && treePresent) return true

  // Probe 2: legacy .jsonl
  if (existsSync(join(convDir, `${sessionId}.jsonl`))) return true

  // Probe 3: v1 .json
  if (existsSync(join(convDir, `${sessionId}.json`))) return true

  return false
}

/**
 * Attach a persisted "image" content block to its owning tool-call row in
 * `result`. Mirrors the engine's flattenEntries image handling (list.go):
 *
 *  - When the block carries a non-empty `tool_use_id`, attach to the matching
 *    tool-call row (by the toolCallIndex map). An image with a non-empty
 *    tool_use_id but no matching tool call (orphan) is dropped.
 *  - Legacy pre-tool_use_id images (persisted before the stamping existed) have
 *    an empty tool_use_id, so the map lookup can never match. The persisted
 *    block order is [tool_result, tool_result, image, image], so these images
 *    belong to the most recent tool-call row — attach to the last tool-role row.
 *
 * The image bytes are re-derived to an on-disk path via imageAttachmentFromBlock
 * (content-addressed; never base64 on the row).
 */
function attachImageToToolRow(
  result: any[],
  toolCallIndex: Record<string, number>,
  convId: string,
  block: any,
): void {
  const att = imageAttachmentFromBlock(convId, block)
  if (!att) return
  const toolUseId: string = block.tool_use_id || ''
  if (toolUseId) {
    const idx = toolCallIndex[toolUseId]
    if (idx !== undefined) {
      ;(result[idx].attachments ||= []).push(att)
    }
    // Orphan (non-empty id, no matching tool call): dropped, mirroring the engine.
    return
  }
  // Legacy empty-id image: attach to the most recent tool-role row.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'tool') {
      ;(result[i].attachments ||= []).push(att)
      return
    }
  }
}

export function loadEngineConversationMessages(sessionId: string): any[] {
  const convDir = resolveConversationsDirSync(principalSubjectForConversation(sessionId))
  const filePath = join(convDir, `${sessionId}.jsonl`)
  if (!existsSync(filePath)) {
    log('session_meta: loadEngineConversation file not found', { path: filePath })
    return []
  }

  const data = readFileSync(filePath, 'utf-8')
  const lines = data.split('\n').filter(Boolean)
  const result: any[] = []
  const toolCallIndex: Record<string, number> = {}

  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.meta || obj.type !== 'message') continue

    const msg = obj.data
    if (!msg || !msg.role) continue
    const timestamp = obj.timestamp || 0

    if (msg.role === 'user') {
      const content = msg.content
      // How the turn was authored. This direct-file reader rebuilds each row
      // field by field, so anything not copied here is LOST on the paths that
      // fall back to it — which is how a Guided Questions submission reloaded
      // as an ordinary user message with none of its chrome.
      const injectionKind = typeof msg.injectionKind === 'string' && msg.injectionKind
        ? msg.injectionKind
        : undefined
      if (typeof content === 'string') {
        if (content.trim()) {
          const cleaned = cleanCliTags(content)
          result.push({ role: 'user', content: cleaned, timestamp, injectionKind, internal: isInternalMessage(content) })
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const cleaned = cleanCliTags(block.text)
            if (cleaned) textParts.push(cleaned)
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const idx = toolCallIndex[block.tool_use_id]
            if (idx !== undefined) {
              let resultContent = ''
              if (typeof block.content === 'string') {
                resultContent = block.content
              } else if (Array.isArray(block.content)) {
                resultContent = block.content
                  .filter((p: any) => p.type === 'text')
                  .map((p: any) => p.text)
                  .join('\n')
              }
              result[idx].content = resultContent
            }
          } else if (block.type === 'image') {
            // A persisted tool-result image block. The live path emitted an
            // image_content event per image and clients attached it to the
            // owning tool message; that event is not persisted, so on reload we
            // replay the reference here. Mirrors the engine's flattenEntries
            // (list.go): re-derive the on-disk path from the inline base64
            // (content-addressed, idempotent — resolves to the same file the
            // engine wrote) and attach it to the owning tool-call row.
            attachImageToToolRow(result, toolCallIndex, sessionId, block)
          }
        }
        if (textParts.length > 0) {
          const joined = textParts.join('\n')
          result.push({ role: 'user', content: joined, timestamp, injectionKind, internal: isInternalMessage(joined) })
        }
      }
    } else if (msg.role === 'assistant') {
      const content = msg.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const cleaned = cleanCliTags(block.text)
          if (cleaned) result.push({ role: 'assistant', content: cleaned, timestamp })
        } else if (block.type === 'tool_use') {
          let inputJSON = ''
          if (block.input) {
            try { inputJSON = JSON.stringify(block.input) } catch { /* silent-ok: unserializable tool input; leave inputJSON empty */ }
          }
          toolCallIndex[block.id] = result.length
          result.push({
            role: 'tool',
            content: '',
            toolName: stripEngineBridgePrefix(block.name),
            toolId: block.id,
            toolInput: inputJSON,
            timestamp,
          })
        }
      }
    }
  }

  log('session_meta: loadEngineConversation loaded', { count: result.length, path: filePath })
  return result
}

export function loadClaudeSessionMessages(sessionId: string, projectPath?: string, encodedDir?: string): any[] {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  let dir: string | null = null

  if (encodedDir) {
    dir = join(projectsRoot, encodedDir)
  } else if (projectPath) {
    const encoded = projectPath.replace(/\//g, '-')
    dir = join(projectsRoot, encoded)
  }

  if (!dir) return []

  const filePath = join(dir, `${sessionId}.jsonl`)
  if (!existsSync(filePath)) {
    log('session_meta: loadClaudeSessionMessages file not found', { path: filePath })
    return []
  }

  const data = readFileSync(filePath, 'utf-8')
  const lines = data.split('\n').filter(Boolean)
  const result: any[] = []
  const toolCallIndex: Record<string, number> = {}

  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    const type = obj.type
    if (type !== 'user' && type !== 'assistant') continue

    const content = obj.message?.content
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : 0

    if (type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) {
          const cleaned = cleanCliTags(content)
          result.push({ role: 'user', content: cleaned, timestamp, internal: isInternalMessage(content) })
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const cleaned = cleanCliTags(block.text)
            if (cleaned) textParts.push(cleaned)
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const idx = toolCallIndex[block.tool_use_id]
            if (idx !== undefined) {
              let resultContent = ''
              if (typeof block.content === 'string') {
                resultContent = block.content
              } else if (Array.isArray(block.content)) {
                resultContent = block.content
                  .filter((p: any) => p.type === 'text')
                  .map((p: any) => p.text)
                  .join('\n')
              }
              result[idx].content = resultContent
            }
          }
        }
        if (textParts.length > 0) {
          const joined = textParts.join('\n')
          result.push({ role: 'user', content: joined, timestamp, internal: isInternalMessage(joined) })
        }
      }
    } else if (type === 'assistant') {
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const cleaned = cleanCliTags(block.text)
          if (cleaned) {
            result.push({ role: 'assistant', content: cleaned, timestamp })
          }
        } else if (block.type === 'tool_use') {
          let inputJSON = ''
          if (block.input) {
            try { inputJSON = JSON.stringify(block.input) } catch { /* silent-ok: unserializable tool input; leave inputJSON empty */ }
          }
          toolCallIndex[block.id] = result.length
          result.push({
            role: 'tool',
            content: '',
            toolName: stripEngineBridgePrefix(block.name),
            toolId: block.id,
            toolInput: inputJSON,
            timestamp,
          })
        }
      }
    }
  }

  return result
}
