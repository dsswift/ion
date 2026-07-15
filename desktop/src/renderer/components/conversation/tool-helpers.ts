import type { Message } from '../../../shared/types'
import { mergeThinkingMessages } from './thinking-block-helpers'

// ─── Types ───

export type GroupedItem =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  | { kind: 'system'; message: Message }
  | { kind: 'harness'; message: Message; bootstrapCollapsedCount?: number }
  | { kind: 'intercept'; message: Message }
  | { kind: 'tool-group'; messages: Message[] }
  | { kind: 'agent-turn'; tools: Message[]; assistantMessages: Message[]; isActive: boolean; thinking?: Message }
  | { kind: 'thinking'; message: Message }
  | { kind: 'compaction'; message: Message }

// ─── Hidden system messages ───

const HIDDEN_MESSAGES = [
  'Plan mode is not active. Do not create plans or call ExitPlanMode. Implement the requested changes directly using Edit, Write, and Bash tools.',
]

const BOOTSTRAP_PREFIX = 'Session bootstrapped'

// ─── groupMessages ───

interface GroupOptions {
  includeUser?: boolean
  hiddenMessages?: string[]
  unifiedTurnView?: boolean
}

export function groupMessages(messages: Message[], opts?: GroupOptions): GroupedItem[] {
  const includeUser = opts?.includeUser ?? true
  const hidden = opts?.hiddenMessages ?? HIDDEN_MESSAGES

  if (opts?.unifiedTurnView) {
    return groupMessagesUnified(messages, includeUser, hidden)
  }

  const result: GroupedItem[] = []
  let toolBuf: Message[] = []
  let bootstrapBuf: Message[] = []
  let _totalRunsFlushed = 0
  let _totalSuppressed = 0

  const flushTools = () => {
    if (toolBuf.length > 0) {
      result.push({ kind: 'tool-group', messages: [...toolBuf] })
      toolBuf = []
    }
  }

  const flushBootstrap = () => {
    if (bootstrapBuf.length === 0) return
    const suppressed = bootstrapBuf.length - 1
    const representative = bootstrapBuf[bootstrapBuf.length - 1]
    const item: GroupedItem = {
      kind: 'harness',
      message: representative,
      bootstrapCollapsedCount: suppressed > 0 ? suppressed : undefined,
    }
    result.push(item)
    _totalRunsFlushed++
    _totalSuppressed += suppressed
    bootstrapBuf = []
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && hidden.includes((msg.content || '').trim())) continue
    if (msg.role === 'tool') {
      flushBootstrap()
      toolBuf.push(msg)
    } else if (msg.role === 'thinking') {
      // Extended-thinking row (issue #158). In the non-unified view there
      // is no turn container to host it inside, so emit it as a standalone
      // collapsed block in stream order. It naturally precedes the tool
      // group that follows because thinking_block_start fires before the
      // first tool_use of the turn.
      flushBootstrap()
      flushTools()
      result.push({ kind: 'thinking', message: msg })
    } else {
      flushTools()
      if (msg.role === 'user') {
        flushBootstrap()
        if (includeUser) result.push({ kind: 'user', message: msg })
      } else if (msg.role === 'assistant') {
        flushBootstrap()
        result.push({ kind: 'assistant', message: msg })
      } else if (msg.role === 'harness') {
        if (msg.interceptLevel) {
          flushBootstrap()
          result.push({ kind: 'intercept', message: msg })
        } else if ((msg.content || '').startsWith(BOOTSTRAP_PREFIX)) {
          bootstrapBuf.push(msg)
        } else {
          flushBootstrap()
          result.push({ kind: 'harness', message: msg })
        }
      } else if (msg.role === 'system' && (msg.content || '').startsWith('[Compaction]')) {
        flushBootstrap()
        result.push({ kind: 'compaction', message: msg })
      } else {
        flushBootstrap()
        result.push({ kind: 'system', message: msg })
      }
    }
  }
  flushTools()
  flushBootstrap()

  return result
}

// ─── Unified turn-grouping (agent-turn mode) ───

function groupMessagesUnified(
  messages: Message[],
  includeUser: boolean,
  hidden: string[],
): GroupedItem[] {
  const result: GroupedItem[] = []
  let turnTools: Message[] = []
  let turnAssistant: Message[] = []
  // All thinking rows for the current turn, in stream order. A single run
  // makes many API rounds and each opens its own thinking block, so a turn
  // routinely accumulates many `role: 'thinking'` rows. They are merged into
  // ONE display row per turn at flush time (mergeThinkingMessages) — one
  // continuous thought stream pinned at the top of the turn, mirroring how
  // the unified view merges the rest of the turn.
  let turnThinking: Message[] = []
  let bootstrapBuf: Message[] = []
  let _totalRunsFlushed2 = 0
  let _totalSuppressed2 = 0

  const flushBootstrap = () => {
    if (bootstrapBuf.length === 0) return
    const suppressed = bootstrapBuf.length - 1
    const representative = bootstrapBuf[bootstrapBuf.length - 1]
    result.push({
      kind: 'harness',
      message: representative,
      bootstrapCollapsedCount: suppressed > 0 ? suppressed : undefined,
    })
    _totalRunsFlushed2++
    _totalSuppressed2 += suppressed
    bootstrapBuf = []
  }

  const flushTurn = () => {
    // Merge the turn's thinking rows (if any) into one display message —
    // exactly one thought bubble per turn.
    const merged = turnThinking.length > 0 ? mergeThinkingMessages(turnThinking) : null
    if (turnTools.length > 0) {
      const isActive = turnTools.some((t) => t.toolStatus === 'running')
      result.push({
        kind: 'agent-turn',
        tools: [...turnTools],
        assistantMessages: [...turnAssistant],
        isActive,
        // Hoist the merged thinking row into the turn header (rendered
        // above the tool row by AgentTurnGroup). undefined when the model
        // did not reason this turn.
        ...(merged ? { thinking: merged } : {}),
      })
    } else {
      // No tools — there is no turn container, so emit the merged thinking
      // row (if any) as a standalone collapsed block first, then each
      // assistant message. Thinking precedes assistant output, matching the
      // engine's block_start → text ordering within a turn.
      if (merged) {
        result.push({ kind: 'thinking', message: merged })
      }
      for (const m of turnAssistant) {
        result.push({ kind: 'assistant', message: m })
      }
    }
    turnTools = []
    turnAssistant = []
    turnThinking = []
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && hidden.includes((msg.content || '').trim())) continue

    if (msg.role === 'user') {
      flushTurn()
      flushBootstrap()
      if (includeUser) result.push({ kind: 'user', message: msg })
    } else if (msg.role === 'thinking') {
      // Accumulate the turn's thinking rows; they merge into one display
      // row per turn at flush time (see flushTurn). Never emitted standalone
      // mid-turn — that is what fragmented a turn into dozens of independent
      // "Thought" rows.
      flushBootstrap()
      turnThinking.push(msg)
    } else if (msg.role === 'tool') {
      flushBootstrap()
      turnTools.push(msg)
    } else if (msg.role === 'assistant') {
      flushBootstrap()
      turnAssistant.push(msg)
    } else if (msg.role === 'harness') {
      if (msg.interceptLevel) {
        flushTurn()
        flushBootstrap()
        result.push({ kind: 'intercept', message: msg })
      } else if ((msg.content || '').startsWith(BOOTSTRAP_PREFIX)) {
        bootstrapBuf.push(msg)
      } else {
        flushTurn()
        flushBootstrap()
        result.push({ kind: 'harness', message: msg })
      }
    } else if (msg.role === 'system' && (msg.content || '').startsWith('[Compaction]')) {
      flushTurn()
      flushBootstrap()
      result.push({ kind: 'compaction', message: msg })
    } else {
      flushTurn()
      flushBootstrap()
      result.push({ kind: 'system', message: msg })
    }
  }

  flushTurn()
  flushBootstrap()

  return result
}

// ─── stripCdPrefix ───

// Strip a single leading `cd <path> && ` (or `cd <path>; `) from a bash command
// for display purposes only. The underlying toolInput is never mutated — this
// is purely a cosmetic transform so tool rows show the meaningful command
// instead of being dominated by an absolute-path prefix. Only strips one leading
// hop, so chained `cd a && cd b && cmd` becomes `cd b && cmd` rather than
// vanishing entirely.
const CD_PREFIX_RE = /^\s*cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/

export function stripCdPrefix(cmd: string): string {
  return cmd.replace(CD_PREFIX_RE, '')
}

// ─── getToolDescription ───

export function getToolDescription(name: string, input?: string): string {
  if (!input) return name

  try {
    const parsed = JSON.parse(input)
    switch (name) {
      case 'Read': return `Read ${parsed.file_path || parsed.path || 'file'}`
      case 'Edit': return `Edit ${parsed.file_path || 'file'}`
      case 'Write': return `Write ${parsed.file_path || 'file'}`
      case 'Glob': return `Search files: ${parsed.pattern || ''}`
      case 'Grep': return `Search: ${parsed.pattern || ''}`
      case 'Bash': {
        const raw = parsed.command || ''
        // Strip leading `cd <path> && ` so the row shows the real command.
        const cmd = stripCdPrefix(raw)
        return cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd || 'Bash'
      }
      case 'WebSearch': return `Search: ${parsed.query || parsed.search_query || ''}`
      case 'WebFetch': return `Fetch: ${parsed.url || ''}`
      case 'Agent': return `Agent: ${(parsed.prompt || parsed.description || '').substring(0, 50)}`
      default: return name
    }
  } catch {
    // Partial JSON during streaming — extract key values via regex
    const str = (p: string) => {
      const m = new RegExp(`"${p}"\\s*:\\s*"([^"]*)"` ).exec(input)
      return m?.[1] || ''
    }
    switch (name) {
      case 'Read': case 'Edit': case 'Write': {
        const fp = str('file_path') || str('path')
        return fp ? `${name} ${fp}` : name
      }
      case 'Glob': { const v = str('pattern'); return v ? `Search files: ${v}` : name }
      case 'Grep': { const v = str('pattern'); return v ? `Search: ${v}` : name }
      case 'Bash': {
        // Same cd-prefix strip for the streaming-partial branch.
        const raw = str('command')
        if (!raw) return name
        const v = stripCdPrefix(raw)
        return v.length > 60 ? v.substring(0, 57) + '...' : v
      }
      case 'WebSearch': { const v = str('query') || str('search_query'); return v ? `Search: ${v}` : name }
      case 'WebFetch': { const v = str('url'); return v ? `Fetch: ${v}` : name }
      case 'Agent': { const v = str('description') || str('prompt'); return v ? `Agent: ${v.substring(0, 50)}` : name }
      default: return name
    }
  }
}

// ─── toolFailureSummary ───

/**
 * Returns failure counts for the collapsed tool-group three-state status
 * display.
 *
 * - failed: number of tools with toolStatus === 'error'
 * - total: tools.length (all tools in the group)
 * - running: true when any tool has toolStatus === 'running'
 *
 * The pass/fail denominator for mixed/all-failed classification is
 * settled = total - runningCount, so callers must not include running tools
 * in the failure ratio while a run is still in flight. The running flag is
 * returned here so the caller can suppress failure UI while work continues.
 */
export function toolFailureSummary(tools: Message[]): { failed: number; total: number; running: boolean } {
  let failed = 0
  let running = false
  for (const t of tools) {
    if (t.toolStatus === 'error') failed++
    if (t.toolStatus === 'running') running = true
  }
  return { failed, total: tools.length, running }
}

// ─── toolSummary ───

export function toolSummary(tools: Message[]): string {
  if (tools.length === 0) return ''
  const first = tools[0]
  const desc = getToolDescription(first.toolName || 'Tool', first.toolInput)
  if (tools.length === 1) return desc
  return `${desc} and ${tools.length - 1} more tool${tools.length > 2 ? 's' : ''}`
}
