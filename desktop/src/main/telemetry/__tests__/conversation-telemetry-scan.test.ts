import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanConversation } from '../conversation-telemetry-scan'

interface Entry {
  id: string
  parentId: string | null
  type: string
  timestamp: number
  data?: Record<string, unknown>
}

/**
 * Build a conversation on disk. Entries are chained in order unless they carry
 * an explicit parentId, which keeps the fixtures readable while still letting a
 * test place a detached entry the way the engine records dispatches.
 */
function writeConversation(
  dir: string,
  id: string,
  entries: Array<Partial<Entry> & { type: string }>,
  llmHeader: Record<string, unknown> = {},
): void {
  let previous: string | null = null
  let clock = 1000
  const lines: string[] = []
  let leafId = ''
  entries.forEach((entry, index) => {
    const entryId = entry.id ?? `e${index}`
    const parentId = entry.parentId !== undefined ? entry.parentId : previous
    if (parentId !== null || entry.parentId === undefined) leafId = entryId
    if (entry.parentId === undefined) previous = entryId
    lines.push(JSON.stringify({
      id: entryId,
      parentId,
      type: entry.type,
      timestamp: entry.timestamp ?? (clock += 10),
      data: entry.data ?? {},
    }))
  })
  writeFileSync(
    join(dir, `${id}.tree.jsonl`),
    [JSON.stringify({ meta: true, id, leafId, version: 2, workingDirectory: '/repo' }), ...lines].join('\n') + '\n',
  )
  writeFileSync(
    join(dir, `${id}.llm.jsonl`),
    JSON.stringify({ meta: true, id, version: 2, createdAt: 1000, model: 'test-model', totalInputTokens: 10, totalOutputTokens: 20, totalCost: 0.5, ...llmHeader }) + '\n',
  )
}

function prompt(text: string, extra: Record<string, unknown> = {}): Partial<Entry> & { type: string } {
  return { type: 'message', data: { role: 'user', content: [{ type: 'text', text }], ...extra } }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ion-telemetry-'))
}

describe('conversation telemetry scan', () => {
  it('splits turns and tokens by the model that served them', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-models', [
      prompt('plan this'),
      { type: 'message', data: { role: 'assistant', content: [], model: 'claude-fable-5-1', usage: { input_tokens: 100, output_tokens: 10 } } },
      { type: 'message', data: { role: 'assistant', content: [], model: 'claude-fable-5-1', usage: { input_tokens: 200, output_tokens: 20 } } },
      { type: 'model_change', data: { model: 'claude-opus-5', previousModel: 'claude-fable-5-1' } },
      prompt('now build it'),
      { type: 'message', data: { role: 'assistant', content: [], model: 'claude-opus-5', usage: { input_tokens: 50, output_tokens: 5 } } },
    ], { model: 'claude-opus-5' })

    const record = scanConversation('conv-models', { conversationsDir: dir })

    // The header names the model the conversation ran on LAST. Reading the
    // order from the turns is what makes models[0] the model it started on.
    expect(record?.models).toEqual(['claude-fable-5-1', 'claude-opus-5'])
    expect(record?.modelChanges).toEqual([
      { at: expect.any(Number), model: 'claude-opus-5', previousModel: 'claude-fable-5-1' },
    ])
    expect(record?.modelUsage.map((u) => [u.model, u.assistantTurns, u.inputTokens, u.outputTokens])).toEqual([
      ['claude-fable-5-1', 2, 300, 30],
      ['claude-opus-5', 1, 50, 5],
    ])
  })

  it('attributes a turn with no recorded model rather than dropping it', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-model-legacy', [
      prompt('hello'),
      { type: 'message', data: { role: 'assistant', content: [] } },
    ])

    const record = scanConversation('conv-model-legacy', { conversationsDir: dir })

    expect(record?.assistantTurnCount).toBe(1)
    expect(record?.modelUsage).toEqual([
      { model: 'unknown', assistantTurns: 1, inputTokens: 0, outputTokens: 0, firstAt: expect.any(Number), lastAt: expect.any(Number) },
    ])
  })

  it('falls back to the header model when no turn names one', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-model-header', [prompt('only a prompt')], { model: 'claude-sonnet-5' })

    const record = scanConversation('conv-model-header', { conversationsDir: dir })

    expect(record?.models).toEqual(['claude-sonnet-5'])
    expect(record?.modelUsage).toEqual([])
  })

  it('counts prompts from before a /clear, which no context window still holds', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-clear', [
      prompt('first'),
      { type: 'message', data: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      prompt('second'),
      { type: 'message', data: { role: 'user', content: [{ type: 'text', text: '/clear' }], slashCommand: '/clear', displayOnly: true } },
      { type: 'cleared' },
      prompt('third, after the clear'),
    ])

    const record = scanConversation('conv-clear', { conversationsDir: dir })

    // Three real prompts: the /clear invocation is display-only and is not one.
    // A scan that stopped at the clear boundary would report 1.
    expect(record?.userPromptCount).toBe(3)
    expect(record?.clearMarkers).toHaveLength(1)
  })

  it('does not count tool returns, context injections, or skill listings as prompts', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-noise', [
      prompt('real prompt'),
      { type: 'message', data: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }] } },
      { type: 'message', data: { role: 'user', content: [{ type: 'context_injection', text: 'AGENTS.md' }] } },
      { type: 'message', data: { role: 'user', content: [{ type: 'skill_listing', text: 'skills' }] } },
    ])

    expect(scanConversation('conv-noise', { conversationsDir: dir })?.userPromptCount).toBe(1)
  })

  it('counts failed tool results by the tool that produced them', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-errors', [
      prompt('go'),
      {
        type: 'message',
        data: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-1', name: 'Edit', input: {} },
            { type: 'tool_use', id: 'call-2', name: 'Bash', input: {} },
          ],
        },
      },
      {
        type: 'message',
        data: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'no match' },
            { type: 'tool_result', tool_use_id: 'call-2', is_error: false, content: 'fine' },
          ],
        },
      },
    ])

    const record = scanConversation('conv-errors', { conversationsDir: dir })
    expect(record?.toolCalls).toEqual({ Edit: 1, Bash: 1 })
    expect(record?.toolErrors).toEqual({ Edit: 1 })
  })

  it('counts an operator stop followed by a fresh prompt as one course correction', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-stop', [
      prompt('do the wrong thing'),
      { type: 'aborted', data: { runId: 'run-1', source: 'user', scope: 'all', signal: 'cancelled' } },
      prompt('no, do this instead'),
    ])

    const record = scanConversation('conv-stop', { conversationsDir: dir })
    expect(record?.stops).toHaveLength(1)
    expect(record?.stops[0]?.source).toBe('user')
    expect(record?.courseCorrections).toBe(1)
  })

  it('never counts a steer as a course correction', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-steer', [
      prompt('start'),
      { type: 'steer_marker', data: { messageLength: 224 } },
      { type: 'steer_marker', data: { messageLength: 40 } },
      prompt('next'),
    ])

    const record = scanConversation('conv-steer', { conversationsDir: dir })
    expect(record?.steerCount).toBe(2)
    expect(record?.steerMessageLengths).toEqual([224, 40])
    // The whole point: steers are mid-turn additions, not redirects.
    expect(record?.courseCorrections).toBe(0)
  })

  it('does not count an engine-side cancel as an operator redirect', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-engine-stop', [
      prompt('start'),
      { type: 'aborted', data: { runId: 'run-9', source: 'engine', signal: 'cancelled' } },
      prompt('carry on'),
    ])

    const record = scanConversation('conv-engine-stop', { conversationsDir: dir })
    expect(record?.stops).toHaveLength(1)
    expect(record?.courseCorrections).toBe(0)
  })

  it('records slash commands, plan markers, compactions, and detached dispatches', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-timeline', [
      prompt('/implement 377', { slashCommand: '/implement', slashSource: 'ion' }),
      { type: 'plan_marker', data: { operation: 'created', planFilePath: '/plans/a.md', planSlug: 'a' } },
      { type: 'compaction', data: { strategy: 'auto', tokensBefore: 150000, summary: 'x' } },
      {
        type: 'agent_dispatch',
        parentId: null,
        data: { agentName: 'implement-agent', status: 'done', conversationId: 'child-1' },
      },
    ])

    const record = scanConversation('conv-timeline', { conversationsDir: dir })
    expect(record?.slashCommands.map((c) => c.name)).toEqual(['/implement'])
    expect(record?.planMarkers[0]?.operation).toBe('created')
    expect(record?.compactions[0]?.tokensBefore).toBe(150000)
    // Dispatches are recorded detached from the message chain; a path-only walk
    // would report a conversation with dispatches as having none.
    expect(record?.dispatches.count).toBe(1)
    expect(record?.dispatches.conversationIds).toEqual(['child-1'])
  })

  it('returns no message text anywhere in the payload', () => {
    const dir = tempDir()
    const secret = 'SENSITIVE-PROMPT-TEXT'
    writeConversation(dir, 'conv-text', [
      prompt(secret),
      { type: 'message', data: { role: 'assistant', content: [{ type: 'text', text: 'ASSISTANT-TEXT' }] } },
      {
        type: 'message',
        data: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'TOOL-OUTPUT' }] },
      },
    ])

    const serialized = JSON.stringify(scanConversation('conv-text', { conversationsDir: dir }))
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('ASSISTANT-TEXT')
    expect(serialized).not.toContain('TOOL-OUTPUT')
  })

  it('reads money, tokens, and the parent link from the llm header', () => {
    const dir = tempDir()
    writeConversation(dir, 'conv-header', [prompt('hi')], { parentId: 'conv-older', totalCost: 1.25 })

    const record = scanConversation('conv-header', { conversationsDir: dir })
    expect(record?.parentId).toBe('conv-older')
    expect(record?.costUsd).toBe(1.25)
    expect(record?.models).toEqual(['test-model'])
    expect(record?.treePath).toBe(join(dir, 'conv-header.tree.jsonl'))
  })

  it('returns null for a conversation that never saved', () => {
    expect(scanConversation('phantom', { conversationsDir: tempDir() })).toBeNull()
  })
})
