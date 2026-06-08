import type { Message } from '../../../shared/types'

// ─── Types ───

export type GroupedItem =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  | { kind: 'system'; message: Message }
  | { kind: 'harness'; message: Message; bootstrapCollapsedCount?: number }
  | { kind: 'intercept'; message: Message }
  | { kind: 'tool-group'; messages: Message[] }
  | { kind: 'agent-turn'; tools: Message[]; assistantMessages: Message[]; isActive: boolean }
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
  let totalRunsFlushed = 0
  let totalSuppressed = 0

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
    totalRunsFlushed++
    totalSuppressed += suppressed
    bootstrapBuf = []
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && hidden.includes((msg.content || '').trim())) continue
    if (msg.role === 'tool') {
      flushBootstrap()
      toolBuf.push(msg)
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
  let bootstrapBuf: Message[] = []
  let totalRunsFlushed = 0
  let totalSuppressed = 0

  const flushBootstrap = () => {
    if (bootstrapBuf.length === 0) return
    const suppressed = bootstrapBuf.length - 1
    const representative = bootstrapBuf[bootstrapBuf.length - 1]
    result.push({
      kind: 'harness',
      message: representative,
      bootstrapCollapsedCount: suppressed > 0 ? suppressed : undefined,
    })
    totalRunsFlushed++
    totalSuppressed += suppressed
    bootstrapBuf = []
  }

  const flushTurn = () => {
    if (turnTools.length > 0) {
      const isActive = turnTools.some((t) => t.toolStatus === 'running')
      result.push({
        kind: 'agent-turn',
        tools: [...turnTools],
        assistantMessages: [...turnAssistant],
        isActive,
      })
    } else {
      // No tools — emit each assistant message as a standalone item
      for (const m of turnAssistant) {
        result.push({ kind: 'assistant', message: m })
      }
    }
    turnTools = []
    turnAssistant = []
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && hidden.includes((msg.content || '').trim())) continue

    if (msg.role === 'user') {
      flushTurn()
      flushBootstrap()
      if (includeUser) result.push({ kind: 'user', message: msg })
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
// instead of being dominated by an absolute-path prefix. Matches Claude Code's
// behavior (see public/claude-code/src/utils/api.ts:586 which strips
// `cd ${cwd} && ` before display). Only strips one leading hop, so chained
// `cd a && cd b && cmd` becomes `cd b && cmd` rather than vanishing entirely.
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

// ─── toolSummary ───

export function toolSummary(tools: Message[]): string {
  if (tools.length === 0) return ''
  const first = tools[0]
  const desc = getToolDescription(first.toolName || 'Tool', first.toolInput)
  if (tools.length === 1) return desc
  return `${desc} and ${tools.length - 1} more tool${tools.length > 2 ? 's' : ''}`
}
