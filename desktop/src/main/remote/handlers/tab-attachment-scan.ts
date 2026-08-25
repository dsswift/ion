/**
 * Pure attachment-extraction for the iOS `desktop_load_attachments` reply.
 *
 * `handleLoadAttachments` pulls the raw store data out of the renderer via a
 * single `executeJavaScript` projection, then hands it here. Keeping the scan
 * as an importable pure function (rather than a giant inlined `executeJavaScript`
 * string) is what makes it unit-testable — the inline form drifted from the
 * renderer's `StatusBarAttachmentsParser` and silently dropped engine-generated
 * images attached to `role: 'tool'`/`role: 'assistant'` messages, which is the
 * defect this module fixes and pins.
 *
 * Recognized sources (mirrors `StatusBarAttachmentsParser.parseAttachmentsFromMessages`
 * so the iOS panel matches the desktop status-bar panel):
 *
 *   1. Structured attachments on `role: 'user'` messages (uploads).
 *   2. Engine-generated image attachments on `role: 'tool'`/`role: 'assistant'`
 *      messages (tool-returned and provider-generated images). THIS is the branch
 *      the old inline scan was missing.
 *   3. Content markers `[Attached (image|file|plan): PATH]` on user messages.
 *   4. `role: 'system'` plan-mode divider messages carrying `planFilePath`.
 *   5. Plan-writing tool calls (`Write`/`Edit`/`NotebookEdit`) targeting `**\/plans/*.md`.
 *   6. The active instance's current `planFilePath`.
 *   7. Conversation-scoped resources (any extension-declared kind), encoded via the
 *      shared, unit-tested `resourceToAttachmentEntry`.
 */

import { resourceToAttachmentEntry, type ResourceLike } from './resource-attachment-entry'

/** Minimal message projection the scan needs. Produced by the renderer
 *  projection in `handleLoadAttachments`; `content` is only carried for user
 *  messages (the only role that uses content markers) to bound payload size. */
export interface ScanMessage {
  role: string
  content?: string
  attachments?: Array<{ type?: string; name?: string; path?: string }>
  planFilePath?: string
  toolName?: string
  /** JSON-string tool input (normalized to a string by the projection). */
  toolInput?: string
}

/** Wire entry shape for `desktop_tab_attachments` (matches the iOS
 *  `TabAttachmentEntry`: `type`, `name`, `path`, and `kind` for resources). */
export interface TabAttachmentEntry {
  type: string
  name: string
  path: string
  kind?: string
  producer?: string
}

export interface ScanInput {
  messages: ScanMessage[]
  /** The active conversation instance's current plan path, if any. */
  planFilePath?: string | null
  /** Conversation-scoped resources, pre-filtered to this conversation. */
  resources?: ResourceLike[]
}

const ATTACHMENT_LINE_RE = /^\[Attached (image|file|plan): ([^\]]+)\]$/
const PLAN_WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const PLAN_PATH_RE = /(?:^|\/)plans\/[^/]+\.md$/

/** Extract a plan file path from a plan-writing tool's JSON-string input.
 *  Accepts `file_path`, `path`, or `filePath` (the three shapes the engine's
 *  file-writing tools use), and falls back to a regex when the streamed JSON
 *  is still partial. */
function planPathFromToolInput(toolInput: string | undefined): string | null {
  if (!toolInput) return null
  try {
    const parsed = JSON.parse(toolInput) as { file_path?: unknown; path?: unknown; filePath?: unknown }
    const fp = [parsed.file_path, parsed.path, parsed.filePath].find((v) => typeof v === 'string') as
      | string
      | undefined
    if (fp && PLAN_PATH_RE.test(fp)) return fp
  } catch {
    const m = /"(?:file_path|path|filePath)"\s*:\s*"([^"]+)"/.exec(toolInput)
    if (m && PLAN_PATH_RE.test(m[1])) return m[1]
  }
  return null
}

function basename(path: string): string {
  return path.includes('/') ? path.split('/').pop()! : path
}

/** Build the ordered, de-duplicated attachment list for a conversation. */
export function scanMessagesForAttachments(input: ScanInput): TabAttachmentEntry[] {
  const seen = new Set<string>()
  const result: TabAttachmentEntry[] = []

  const add = (a: TabAttachmentEntry) => {
    if (seen.has(a.path)) return
    seen.add(a.path)
    result.push(a)
  }

  for (const msg of input.messages) {
    // 1. Structured attachments on user messages (uploads).
    if (msg.role === 'user' && msg.attachments) {
      for (const a of msg.attachments) {
        if (!a.path) continue
        const type = a.type === 'image' || a.type === 'plan' ? a.type : 'file'
        add({ type, name: a.name || basename(a.path), path: a.path })
      }
    }

    // 2. Engine-generated image attachments on tool / assistant messages.
    //    Provider-generated (assistant) and tool-returned (tool) images live
    //    here — the branch the old inline scan omitted, which left iOS showing
    //    "No attachments" for image-generation conversations.
    if ((msg.role === 'tool' || msg.role === 'assistant') && msg.attachments) {
      for (const a of msg.attachments) {
        if (a.type !== 'image' || !a.path) continue
        add({ type: 'image', name: a.name || basename(a.path), path: a.path })
      }
    }

    // 3. Content markers on user messages (historical / reloaded conversations).
    if (msg.role === 'user' && msg.content) {
      for (const line of msg.content.split('\n')) {
        const m = ATTACHMENT_LINE_RE.exec(line)
        if (!m) break // markers are leading lines only; stop at first non-marker
        add({ type: m[1], name: basename(m[2]), path: m[2] })
      }
    }

    // 4. Plan-mode divider system messages.
    if (msg.role === 'system' && msg.planFilePath) {
      add({ type: 'plan', name: basename(msg.planFilePath), path: msg.planFilePath })
    }

    // 5. Plan-writing tool calls targeting **/plans/*.md.
    if (msg.role === 'tool' && msg.toolName && PLAN_WRITING_TOOLS.has(msg.toolName)) {
      const path = planPathFromToolInput(msg.toolInput)
      if (path) add({ type: 'plan', name: basename(path), path })
    }
  }

  // 6. The active instance's current plan.
  if (input.planFilePath) {
    add({ type: 'plan', name: basename(input.planFilePath), path: input.planFilePath })
  }

  // 7. Conversation-scoped resources of ANY declared kind.
  for (const item of input.resources ?? []) {
    add(resourceToAttachmentEntry(item))
  }

  return result
}
