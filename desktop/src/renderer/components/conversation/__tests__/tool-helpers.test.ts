import { describe, it, expect } from 'vitest'
import { stripCdPrefix, getToolDescription, groupMessages } from '../tool-helpers'
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
