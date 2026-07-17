/**
 * Pure attachment-detection logic for the StatusBar's attachments
 * popover. Extracted out of `StatusBarAttachmentsButton.tsx` so it can
 * be unit-tested without pulling in the React/theme/preferences
 * import chain (those side-effect on `localStorage`, which isn't
 * available under the renderer test environment).
 *
 * Recognized attachment sources:
 *
 *  1. **Structured user attachments** — `msg.attachments` on
 *     `role: 'user'` messages. Populated by `submitEnginePrompt`
 *     (engine tabs) and `send-slice` (conversation tabs).
 *
 *  2. **Content markers** — leading `[Attached image|file|plan: PATH]`
 *     lines on user messages. Only the conversation send-slice writes
 *     these; included so historical / reloaded conversation messages
 *     still surface their attachments.
 *
 *  3. **Plan-mode system dividers** — `role: 'system'` messages with
 *     `planFilePath`. Emitted by `engine_plan_mode_changed` on engine
 *     tabs. These are renderer-only and don't persist to .tree.jsonl,
 *     so they only fire for live sessions.
 *
 *  4. **Plan-writing tool calls** — `role: 'tool'` with
 *     `toolName ∈ {Write, Edit, NotebookEdit}` and a `file_path`
 *     argument matching `**\/plans/*.md`. This is the persistence-
 *     surviving path on engine tabs: the tool call lives in
 *     .tree.jsonl and rebuilds on reload, so the panel keeps working
 *     after a desktop restart. Fixes the original bug where
 *     conversations like `1780786340847-cb337ae4b3d0` had plans on
 *     disk but the panel showed nothing.
 *
 *  5. **Explicit `planFilePath` argument** — the parser accepts a
 *     standalone path so conversation tabs that track the current
 *     plan via `tab.planFilePath` still surface it.
 */

export interface ParsedAttachment {
  kind: 'image' | 'file' | 'plan'
  name: string
  path: string
}

export interface MsgLike {
  role: string
  content: string
  attachments?: Array<{ type: string; name: string; path: string }> | undefined
  /** Populated on engine `role: 'system'` messages for the plan-mode
   *  divider. See engine-event-slice.ts case 'engine_plan_mode_changed'. */
  planFilePath?: string
  /** Engine messages with `role: 'tool'` carry the tool name and the
   *  JSON-string `toolInput` accumulated from streamed updates. The
   *  parser scans these for `Write`/`Edit` calls targeting plan files. */
  toolName?: string
  toolInput?: string
}

const ATTACHMENT_LINE_RE = /^\[Attached (image|file|plan): ([^\]]+)\]$/

/** Tools that write files. When the agent invokes one of these and the
 *  resolved `file_path` lives under `~/.ion/plans/` (or any path ending
 *  in `/plans/<slug>.md`), we treat the file as a plan attachment for
 *  the conversation. This is the only way to surface plans for engine
 *  conversations that didn't go through `engine_plan_mode_changed`
 *  (the system-divider event), because that divider is a renderer-only
 *  ephemeral message and doesn't persist to `.tree.jsonl`. */
const PLAN_WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

/** Matches plan files in `~/.ion/plans/` or any `**\/plans/` directory.
 *  Looser than "exactly `.ion/plans/`" so a workspace that vendors its
 *  own plans directory still surfaces plan attachments. The `.md`
 *  requirement keeps us from picking up arbitrary files an extension
 *  might write into a `plans/` folder. */
const PLAN_PATH_RE = /(?:^|\/)plans\/[^/]+\.md$/

function tryExtractPlanFilePathFromToolInput(toolInput: string | undefined): string | null {
  if (!toolInput) return null
  // toolInput is a JSON-string; the input shape varies per tool, but
  // every plan-relevant tool we know about uses `file_path`. Parse
  // defensively — partial streamed input may not be valid JSON yet.
  try {
    const parsed = JSON.parse(toolInput) as { file_path?: unknown }
    if (typeof parsed.file_path === 'string' && PLAN_PATH_RE.test(parsed.file_path)) {
      return parsed.file_path
    }
  } catch {
    // Fall back to a regex match against the raw string so we still
    // catch plans during the brief window when the engine is still
    // streaming partial JSON chunks.
    const m = /"file_path"\s*:\s*"([^"]+)"/.exec(toolInput)
    if (m && PLAN_PATH_RE.test(m[1])) return m[1]
  }
  return null
}

export function parseAttachmentsFromMessages(
  messages: MsgLike[],
  planFilePath: string | null,
): ParsedAttachment[] {
  const seen = new Set<string>()
  const result: ParsedAttachment[] = []

  const add = (a: ParsedAttachment) => {
    if (seen.has(a.path)) return
    seen.add(a.path)
    result.push(a)
  }

  for (const msg of messages) {
    // 1. Structured attachments on user messages. Engine user messages
    //    populate this via `submitEnginePrompt` (engine-slice.ts);
    //    conversation user messages via send-slice.ts. Both flow
    //    through here.
    if (msg.role === 'user' && msg.attachments) {
      for (const a of msg.attachments) {
        const kind = (a.type === 'image' || a.type === 'plan') ? a.type : 'file' as const
        add({ kind, name: a.name, path: a.path })
      }
    }

    // 1b. Engine-generated image attachments on tool / assistant messages.
    //     Tool-returned and provider-generated images are attached to the
    //     producing `role: 'tool'` message (by toolId) or the assistant turn
    //     (provider images) by event-slice-images.ts. Surface them in the
    //     attachments panel alongside user uploads.
    if ((msg.role === 'tool' || msg.role === 'assistant') && msg.attachments) {
      for (const a of msg.attachments) {
        if (a.type !== 'image') continue
        add({ kind: 'image', name: a.name, path: a.path })
      }
    }

    // 2. Content markers on user messages. Available for historical /
    //    reloaded conversation-tab messages from JSONL. Engine tabs
    //    don't use markers (the engine submit path passes structured
    //    `attachments` directly), but the scan is cheap and harmless
    //    to run for every user message.
    if (msg.role === 'user') {
      const lines = msg.content.split('\n')
      for (const line of lines) {
        const m = ATTACHMENT_LINE_RE.exec(line)
        if (!m) break // stop at first non-marker line
        const kind = m[1] as 'image' | 'file' | 'plan'
        const path = m[2]
        const name = path.includes('/') ? path.split('/').pop()! : path
        add({ kind, name, path })
      }
    }

    // 3. Plan-mode divider system messages. Engine plan mode emits
    //    `engine_plan_mode_changed` which inserts a `role: 'system'`
    //    message carrying the plan path on `planFilePath`. These don't
    //    persist to `.tree.jsonl` (system dividers are renderer-only
    //    ephemera), so this branch only fires for active sessions.
    if (msg.role === 'system' && msg.planFilePath) {
      const path = msg.planFilePath
      const name = path.includes('/') ? path.split('/').pop()! : path
      add({ kind: 'plan', name, path })
    }

    // 4. Tool-call plan detection on assistant turns. When the agent
    //    invokes `Write`/`Edit`/`NotebookEdit` on a file under
    //    `**/plans/*.md`, surface that file as a plan attachment. This
    //    is the only mechanism that surfaces plans for conversations
    //    that didn't trigger the engine plan-mode flow (e.g. a session
    //    that started in plan mode and the agent wrote the plan
    //    directly — the renderer's divider system message is gone
    //    after a desktop restart because dividers don't persist, but
    //    the tool-call message survives in `.tree.jsonl`).
    if (msg.role === 'tool' && msg.toolName && PLAN_WRITING_TOOLS.has(msg.toolName)) {
      const path = tryExtractPlanFilePathFromToolInput(msg.toolInput)
      if (path) {
        const name = path.includes('/') ? path.split('/').pop()! : path
        add({ kind: 'plan', name, path })
      }
    }
  }

  // Also include the current in-progress plan if any (conversation
  // tabs populate `tab.planFilePath`; engine tabs carry this on the
  // system divider message above, but we keep the prop so explicit
  // callers can pin a known-current plan).
  if (planFilePath) {
    const name = planFilePath.includes('/') ? planFilePath.split('/').pop()! : planFilePath
    add({ kind: 'plan', name, path: planFilePath })
  }

  return result
}
