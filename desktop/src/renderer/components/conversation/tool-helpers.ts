import type { Message } from '../../../shared/types'

// ─── Types ───

export type GroupedItem =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  | { kind: 'system'; message: Message }
  | { kind: 'harness'; message: Message; bootstrapCollapsedCount?: number }
  | { kind: 'tool-group'; messages: Message[] }
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
}

export function groupMessages(messages: Message[], opts?: GroupOptions): GroupedItem[] {
  const includeUser = opts?.includeUser ?? true
  const hidden = opts?.hiddenMessages ?? HIDDEN_MESSAGES

  console.log(`[ENGINE-BOOTSTRAP] groupMessages entry total=${messages.length}`)

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
    console.log(
      `[ENGINE-BOOTSTRAP] flush run count=${bootstrapBuf.length} kept=${representative.id} suppressed=${suppressed}`
    )
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
        if ((msg.content || '').startsWith(BOOTSTRAP_PREFIX)) {
          console.log(`[ENGINE-BOOTSTRAP] enqueue id=${msg.id} buf=${bootstrapBuf.length + 1}`)
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

  console.log(
    `[ENGINE-BOOTSTRAP] groupMessages done runs=${totalRunsFlushed} suppressed=${totalSuppressed} output=${result.length}`
  )
  return result
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
        const cmd = parsed.command || ''
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
      case 'Bash': { const v = str('command'); return v ? (v.length > 60 ? v.substring(0, 57) + '...' : v) : name }
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
