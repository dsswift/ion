import { describe, it, expect } from 'vitest'
import { stripCdPrefix, getToolDescription, groupMessages, toolFailureSummary } from '../tool-helpers'
import type { GroupedItem } from '../tool-helpers'
import type { Message } from '../../../../shared/types'

describe('stripCdPrefix', () => {
  it('strips an absolute-path cd && prefix', () => {
    expect(stripCdPrefix('cd /Users/josh/src && grep -r foo')).toBe('grep -r foo')
  })

  it('strips a double-quoted path with spaces', () => {
    expect(stripCdPrefix('cd "/Users/josh/path with spaces" && ls')).toBe('ls')
  })

  it('strips a single-quoted path', () => {
    expect(stripCdPrefix("cd '/Users/josh/quoted path' && ls")).toBe('ls')
  })

  it('strips a tilde-relative path', () => {
    expect(stripCdPrefix('cd ~/foo && pwd')).toBe('pwd')
  })

  it('strips a cd ... ; cmd form', () => {
    expect(stripCdPrefix('cd /tmp; echo done')).toBe('echo done')
  })

  it('tolerates extra whitespace around the operator', () => {
    expect(stripCdPrefix('cd /tmp   &&   echo go')).toBe('echo go')
  })

  it('tolerates leading whitespace before cd', () => {
    expect(stripCdPrefix('  cd /tmp && ls')).toBe('ls')
  })

  it('does not touch a command without a leading cd', () => {
    expect(stripCdPrefix('grep -r foo')).toBe('grep -r foo')
  })

  it('does not strip a cd that is not at the start of the command', () => {
    // `echo` is the leading command, so we leave the inner `cd` alone.
    expect(stripCdPrefix('echo cd foo && bar')).toBe('echo cd foo && bar')
  })

  it('only strips the first leading cd hop', () => {
    // Chained cds: we strip exactly one and leave the rest intact so the
    // display still reflects the remaining navigation.
    expect(stripCdPrefix('cd /a && cd /b && cmd')).toBe('cd /b && cmd')
  })

  it('returns an empty string unchanged', () => {
    expect(stripCdPrefix('')).toBe('')
  })
})

describe('getToolDescription Bash', () => {
  it('hides the cd prefix in the JSON-parsed path', () => {
    const input = JSON.stringify({ command: 'cd /Users/josh/src && grep -r foo' })
    expect(getToolDescription('Bash', input)).toBe('grep -r foo')
  })

  it('hides the cd prefix in the streaming-partial path', () => {
    // Trailing brace is missing so JSON.parse throws and we fall into the
    // regex-extraction branch.
    const partial = '{"command": "cd /Users/josh/src && grep -r foo"'
    expect(getToolDescription('Bash', partial)).toBe('grep -r foo')
  })

  it('still truncates to 60 chars after stripping the cd prefix', () => {
    const longCmd = 'a'.repeat(80)
    const input = JSON.stringify({ command: `cd /Users/josh && ${longCmd}` })
    const result = getToolDescription('Bash', input)
    // 57 visible chars + '...' = 60-char display budget.
    expect(result.endsWith('...')).toBe(true)
    expect(result.length).toBe(60)
    // The cd prefix must not be present.
    expect(result.startsWith('cd')).toBe(false)
  })

  it('returns "Bash" when the command is empty', () => {
    const input = JSON.stringify({ command: '' })
    expect(getToolDescription('Bash', input)).toBe('Bash')
  })

  it('passes through commands with no cd prefix untouched', () => {
    const input = JSON.stringify({ command: 'ls -la' })
    expect(getToolDescription('Bash', input)).toBe('ls -la')
  })
})

describe('getToolDescription non-Bash sanity', () => {
  it('formats Read with a file path', () => {
    expect(getToolDescription('Read', JSON.stringify({ file_path: '/a/b.ts' }))).toBe('Read /a/b.ts')
  })

  it('returns the tool name when no input is provided', () => {
    expect(getToolDescription('Grep')).toBe('Grep')
  })
})

// ─── groupMessages unified turn view ───

function msg(role: 'user' | 'assistant' | 'tool' | 'system', content = '', extra: Partial<Message> = {}): Message {
  return { id: `${role}-${Math.random().toString(36).slice(2, 8)}`, role, content, timestamp: Date.now(), ...extra }
}

describe('groupMessages unified turn view', () => {
  it('groups multi-tool + text into a single agent-turn', () => {
    const messages = [
      msg('user', 'do something'),
      msg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      msg('tool', '', { toolName: 'Grep', toolStatus: 'completed' }),
      msg('assistant', 'first reply'),
      msg('tool', '', { toolName: 'Edit', toolStatus: 'completed' }),
      msg('assistant', 'second reply'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('user')

    const turn = result[1] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn.kind).toBe('agent-turn')
    expect(turn.tools).toHaveLength(3)
    expect(turn.assistantMessages).toHaveLength(2)
    expect(turn.isActive).toBe(false)
  })

  it('passes through text-only assistant messages without wrapping in agent-turn', () => {
    const messages = [
      msg('user', 'hello'),
      msg('assistant', 'hi there'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('user')
    expect(result[1].kind).toBe('assistant')
  })

  it('breaks the turn on a system message', () => {
    const messages = [
      msg('user', 'go'),
      msg('tool', '', { toolName: 'Bash', toolStatus: 'completed' }),
      msg('system', 'something important'),
      msg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      msg('assistant', 'done'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    // [user, agent-turn(1 tool, 0 assistant), system, agent-turn(1 tool, 1 assistant)]
    expect(result).toHaveLength(4)
    expect(result[0].kind).toBe('user')

    const turn1 = result[1] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn1.kind).toBe('agent-turn')
    expect(turn1.tools).toHaveLength(1)
    expect(turn1.assistantMessages).toHaveLength(0)

    expect(result[2].kind).toBe('system')

    const turn2 = result[3] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn2.kind).toBe('agent-turn')
    expect(turn2.tools).toHaveLength(1)
    expect(turn2.assistantMessages).toHaveLength(1)
  })

  it('uses legacy tool-group behavior when unifiedTurnView is false', () => {
    const messages = [
      msg('user', 'do something'),
      msg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      msg('tool', '', { toolName: 'Grep', toolStatus: 'completed' }),
      msg('assistant', 'first reply'),
      msg('tool', '', { toolName: 'Edit', toolStatus: 'completed' }),
      msg('assistant', 'second reply'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: false })

    // [user, tool-group(2), assistant, tool-group(1), assistant]
    expect(result).toHaveLength(5)
    expect(result[0].kind).toBe('user')
    expect(result[1].kind).toBe('tool-group')
    expect((result[1] as Extract<GroupedItem, { kind: 'tool-group' }>).messages).toHaveLength(2)
    expect(result[2].kind).toBe('assistant')
    expect(result[3].kind).toBe('tool-group')
    expect((result[3] as Extract<GroupedItem, { kind: 'tool-group' }>).messages).toHaveLength(1)
    expect(result[4].kind).toBe('assistant')
  })

  it('also uses legacy behavior when unifiedTurnView is omitted', () => {
    const messages = [
      msg('user', 'hi'),
      msg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      msg('assistant', 'done'),
    ]

    const result = groupMessages(messages)

    expect(result).toHaveLength(3)
    expect(result[0].kind).toBe('user')
    expect(result[1].kind).toBe('tool-group')
    expect(result[2].kind).toBe('assistant')
  })

  it('sets isActive when any tool has toolStatus running', () => {
    const messages = [
      msg('user', 'go'),
      msg('tool', '', { toolName: 'Bash', toolStatus: 'completed' }),
      msg('tool', '', { toolName: 'Read', toolStatus: 'running' }),
      msg('assistant', 'thinking...'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    expect(result).toHaveLength(2)
    const turn = result[1] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn.kind).toBe('agent-turn')
    expect(turn.isActive).toBe(true)
  })

  it('produces an agent-turn with empty assistantMessages for tools-only sequences', () => {
    const messages = [
      msg('user', 'start'),
      msg('tool', '', { toolName: 'Bash', toolStatus: 'running' }),
      msg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('user')

    const turn = result[1] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn.kind).toBe('agent-turn')
    expect(turn.tools).toHaveLength(2)
    expect(turn.assistantMessages).toHaveLength(0)
    expect(turn.isActive).toBe(true)
  })
})

// ─── thinking-row grouping (issue #158) ───
//
// A `role: 'thinking'` message is hoisted into the turn it belongs to. In
// the unified turn view it rides on the agent-turn item (`thinking` field),
// so AgentTurnGroup can render it ABOVE the tool row. When a turn has no
// tools (text-only) the thinking row is emitted as a standalone `thinking`
// item before the assistant text. In the non-unified view every thinking
// row is a standalone `thinking` item in stream order.

function tmsg(role: 'user' | 'assistant' | 'tool' | 'thinking', content = '', extra: Partial<Message> = {}): Message {
  return { id: `${role}-${Math.random().toString(36).slice(2, 8)}`, role, content, timestamp: Date.now(), ...extra } as Message
}

describe('groupMessages — thinking row hoisting (unified turn view)', () => {
  it('hoists a thinking row onto the agent-turn that has tools', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('thinking', 'let me reason', { thinkingActive: false, thinkingElapsedSeconds: 4 }),
      tmsg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      tmsg('assistant', 'done'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('user')
    const turn = result[1] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn.kind).toBe('agent-turn')
    // The thinking row rides on the turn (rendered above the tool row).
    expect(turn.thinking).toBeTruthy()
    expect(turn.thinking?.role).toBe('thinking')
    expect(turn.thinking?.content).toBe('let me reason')
    expect(turn.tools).toHaveLength(1)
    expect(turn.assistantMessages).toHaveLength(1)
  })

  it('emits a standalone thinking item before text when the turn has no tools', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('thinking', 'reasoning', { thinkingActive: false }),
      tmsg('assistant', 'the answer'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    // [user, thinking, assistant] — thinking precedes the assistant output.
    expect(result).toHaveLength(3)
    expect(result[0].kind).toBe('user')
    expect(result[1].kind).toBe('thinking')
    expect((result[1] as Extract<GroupedItem, { kind: 'thinking' }>).message.content).toBe('reasoning')
    expect(result[2].kind).toBe('assistant')
  })

  it('turns without a thinking row leave the turn.thinking field undefined', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      tmsg('assistant', 'done'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })
    const turn = result[1] as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn.kind).toBe('agent-turn')
    expect(turn.thinking).toBeUndefined()
  })

  it('renders thinking rows as standalone items in the non-unified view', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('thinking', 'reasoning', { thinkingActive: false }),
      tmsg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      tmsg('assistant', 'done'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: false })

    // Non-unified: thinking is its own item, emitted before the tool group.
    const kinds = result.map((r) => r.kind)
    expect(kinds).toContain('thinking')
    const thinkingIdx = kinds.indexOf('thinking')
    const toolGroupIdx = kinds.indexOf('tool-group')
    expect(thinkingIdx).toBeGreaterThanOrEqual(0)
    // Thinking precedes the tool group that follows it in stream order.
    expect(thinkingIdx).toBeLessThan(toolGroupIdx)
  })

  // ── one merged thought row per turn ──
  //
  // A single run makes many API rounds; each opens its own thinking block,
  // so a turn accumulates many `role: 'thinking'` rows. The unified view
  // must merge them into ONE thought row per turn — never scatter them as
  // standalone items through the transcript (the pre-fix behavior kept only
  // the newest on the turn and flushed the rest standalone).

  it('merges multiple thinking rows in one turn into a single turn.thinking', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('thinking', 'first thought', { id: 'th-1', thinkingActive: false, thinkingElapsedSeconds: 2, thinkingTotalTokens: 100 }),
      tmsg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      tmsg('thinking', 'second thought', { id: 'th-2', thinkingActive: false, thinkingElapsedSeconds: 3, thinkingTotalTokens: 200 }),
      tmsg('tool', '', { toolName: 'Grep', toolStatus: 'completed' }),
      tmsg('thinking', 'third thought', { id: 'th-3', thinkingActive: false, thinkingElapsedSeconds: 5 }),
      tmsg('assistant', 'done'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    // Exactly one turn item and NO standalone thinking items anywhere.
    const kinds = result.map((r) => r.kind)
    expect(kinds.filter((k) => k === 'thinking')).toHaveLength(0)
    expect(kinds.filter((k) => k === 'agent-turn')).toHaveLength(1)

    const turn = result.find((r) => r.kind === 'agent-turn') as Extract<GroupedItem, { kind: 'agent-turn' }>
    // One merged row: stable first-row id, joined content, summed fields.
    expect(turn.thinking?.id).toBe('th-1')
    expect(turn.thinking?.content).toBe('first thought\n\nsecond thought\n\nthird thought')
    expect(turn.thinking?.thinkingElapsedSeconds).toBe(10)
    expect(turn.thinking?.thinkingTotalTokens).toBe(300)
  })

  it('keeps the merged row live while any block in the turn is still active', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('thinking', 'sealed', { id: 'th-1', thinkingActive: false }),
      tmsg('tool', '', { toolName: 'Read', toolStatus: 'running' }),
      tmsg('thinking', 'streaming…', { id: 'th-2', thinkingActive: true }),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })
    const turn = result.find((r) => r.kind === 'agent-turn') as Extract<GroupedItem, { kind: 'agent-turn' }>
    expect(turn.thinking?.thinkingActive).toBe(true)
  })

  it('emits one merged standalone thinking row in the no-tools path', () => {
    const messages = [
      tmsg('user', 'go'),
      tmsg('thinking', 'part one', { id: 'th-1', thinkingActive: false }),
      tmsg('thinking', 'part two', { id: 'th-2', thinkingActive: false }),
      tmsg('assistant', 'answer'),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })

    // [user, thinking (merged), assistant] — exactly one thinking item.
    const kinds = result.map((r) => r.kind)
    expect(kinds.filter((k) => k === 'thinking')).toHaveLength(1)
    const row = result.find((r) => r.kind === 'thinking') as Extract<GroupedItem, { kind: 'thinking' }>
    expect(row.message.id).toBe('th-1')
    expect(row.message.content).toBe('part one\n\npart two')
  })

  it('does not merge thinking rows across user-turn boundaries', () => {
    const messages = [
      tmsg('user', 'first'),
      tmsg('thinking', 'turn one thought', { id: 'th-1', thinkingActive: false }),
      tmsg('tool', '', { toolName: 'Read', toolStatus: 'completed' }),
      tmsg('user', 'second'),
      tmsg('thinking', 'turn two thought', { id: 'th-2', thinkingActive: false }),
      tmsg('tool', '', { toolName: 'Grep', toolStatus: 'completed' }),
    ]

    const result = groupMessages(messages, { unifiedTurnView: true })
    const turns = result.filter((r) => r.kind === 'agent-turn') as Extract<GroupedItem, { kind: 'agent-turn' }>[]
    expect(turns).toHaveLength(2)
    expect(turns[0].thinking?.content).toBe('turn one thought')
    expect(turns[1].thinking?.content).toBe('turn two thought')
  })
})

// ─── toolFailureSummary ───

function toolMsg(id: string, status: Message['toolStatus']): Message {
  return { id, role: 'tool', content: '', timestamp: 0, toolStatus: status }
}

describe('toolFailureSummary', () => {
  it('all-success: 5 completed tools returns failed==0, running==false', () => {
    const tools = [
      toolMsg('t1', 'completed'),
      toolMsg('t2', 'completed'),
      toolMsg('t3', 'completed'),
      toolMsg('t4', 'completed'),
      toolMsg('t5', 'completed'),
    ]
    const result = toolFailureSummary(tools)
    expect(result.failed).toBe(0)
    expect(result.total).toBe(5)
    expect(result.running).toBe(false)
  })

  it('mixed: 100 tools (3 error, 97 completed) returns failed==3, total==100, running==false', () => {
    const tools: Message[] = [
      ...Array.from({ length: 97 }, (_, i) => toolMsg(`ok-${i}`, 'completed')),
      toolMsg('e1', 'error'),
      toolMsg('e2', 'error'),
      toolMsg('e3', 'error'),
    ]
    const result = toolFailureSummary(tools)
    expect(result.failed).toBe(3)
    expect(result.total).toBe(100)
    expect(result.running).toBe(false)
  })

  it('all-failed: 4 error tools returns failed==4, total==4, running==false', () => {
    const tools = [
      toolMsg('e1', 'error'),
      toolMsg('e2', 'error'),
      toolMsg('e3', 'error'),
      toolMsg('e4', 'error'),
    ]
    const result = toolFailureSummary(tools)
    expect(result.failed).toBe(4)
    expect(result.total).toBe(4)
    expect(result.running).toBe(false)
  })

  it('running: 2 completed + 1 running + 1 error returns running==true', () => {
    const tools = [
      toolMsg('c1', 'completed'),
      toolMsg('c2', 'completed'),
      toolMsg('r1', 'running'),
      toolMsg('e1', 'error'),
    ]
    const result = toolFailureSummary(tools)
    expect(result.running).toBe(true)
    expect(result.total).toBe(4)
  })
})
