import { describe, expect, it } from 'vitest'
import type { Message } from '../../types-session'
import {
  TOOL_CONTENT_WIRE_CAP,
  TRANSCRIPT_FIELD_CLASS,
  projectTranscript,
  projectTranscriptRow,
  utf8Bytes,
} from '../transcript-row'

const base = (over: Partial<Message> = {}): Message => ({ id: 'm1', role: 'assistant', content: 'hi', timestamp: 5, ...over })

describe('projectTranscriptRow', () => {
  it('carries every wire field and no owner-only field', () => {
    const full: Message = {
      id: 'm1', role: 'user', content: 'do it', timestamp: 7,
      toolName: 'Bash', toolInput: '{}', toolId: 't1', toolStatus: 'completed',
      userExecuted: true, planFilePath: '/p.md',
      slashCommand: '/x', slashArgs: 'a', slashSource: 'ion', slashModelAlias: 'fast', slashModelEffective: 'm',
      slashFrontmatter: { k: 1 }, implementationPhase: true, interceptLevel: 'banner',
      steerPending: true, steerFailed: false, steerApplied: true, steerAppliedDividerId: 'd1',
      injectionKind: 'structured_answer',
      thinkingActive: false, thinkingElapsedSeconds: 3, thinkingTotalTokens: 9, thinkingRedacted: false,
      backgroundWork: { kind: 'k', deliveryMode: 'd', items: [] }, backgroundTaskId: 'b1',
      clientMsgId: 'c1',
      sealed: true, dedupKey: 'ext:k',
    }
    const row = projectTranscriptRow(full) as unknown as Record<string, unknown>
    for (const [key, cls] of Object.entries(TRANSCRIPT_FIELD_CLASS)) {
      if (key === 'attachments') continue
      if (cls === 'owner-only') expect(row[key], key).toBeUndefined()
      else expect(row[key], key).toEqual((full as unknown as Record<string, unknown>)[key])
    }
  })

  it('omits absent optional fields entirely', () => {
    expect(projectTranscriptRow(base())).toEqual({ id: 'm1', role: 'assistant', content: 'hi', timestamp: 5 })
  })

  it('keeps every role, including harness and thinking', () => {
    for (const role of ['user', 'assistant', 'tool', 'system', 'harness', 'thinking'] as const) {
      expect(projectTranscriptRow(base({ role })).role).toBe(role)
    }
  })

  it('cuts long tool output and says how big it was', () => {
    const long = 'é'.repeat(TOOL_CONTENT_WIRE_CAP + 10)
    const row = projectTranscriptRow(base({ role: 'tool', content: long }))
    expect(row.content).toHaveLength(TOOL_CONTENT_WIRE_CAP)
    expect(row.contentTruncated).toBe(true)
    expect(row.contentBytes).toBe(utf8Bytes(long))
  })

  it('never cuts text a person or model wrote', () => {
    const long = 'x'.repeat(TOOL_CONTENT_WIRE_CAP * 3)
    const row = projectTranscriptRow(base({ role: 'assistant', content: long }))
    expect(row.content).toBe(long)
    expect(row.contentTruncated).toBeUndefined()
  })

  it('ships attachments as references, never inline bytes', () => {
    const row = projectTranscriptRow(base({
      attachments: [{ id: 'a', type: 'image', name: 'x.png', path: '/x.png', dataUrl: 'data:...', contentHash: 'h', size: 3 }],
    }))
    expect(row.attachments).toEqual([{ id: 'a', type: 'image', name: 'x.png', path: '/x.png', contentHash: 'h', size: 3 }])
  })
})

describe('projectTranscript plan path', () => {
  const write = (id: string, path: string): Message => base({ id, role: 'tool', toolName: 'Write', toolInput: JSON.stringify({ file_path: path }) })
  const exit = (id: string, input: object = {}): Message => base({ id, role: 'tool', toolName: 'ExitPlanMode', toolInput: JSON.stringify(input) })

  it('names the plan written before an ExitPlanMode row that carries none', () => {
    const rows = projectTranscript([write('w1', '/h/.ion/plans/a.md'), exit('e1')])
    expect(rows[1].planFilePath).toBe('/h/.ion/plans/a.md')
  })

  it('prefers the path the call itself names', () => {
    const rows = projectTranscript([write('w1', '/h/.ion/plans/a.md'), exit('e1', { planFilePath: '/own.md' })])
    expect(rows[1].planFilePath).toBe('/own.md')
  })

  it('ignores plans written after the row, so later rows never change it', () => {
    const rows = projectTranscript([exit('e1'), write('w1', '/h/.ion/plans/a.md')])
    expect(rows[0].planFilePath).toBeUndefined()
  })

  // The store's reducer edits tool rows in place. A projection keyed on the
  // row object, or sharing a nested object with it, never saw those edits.
  it('sees a row edited in place, and shares no nested object with it', () => {
    const m = base({ role: 'tool', toolInput: '', backgroundWork: { kind: 'k', deliveryMode: 'd', items: [] } })
    const first = projectTranscript([m])
    m.toolInput = '{"a":1}'
    m.backgroundWork!.kind = 'changed'
    const second = projectTranscript([m])
    expect(second[0].toolInput).toBe('{"a":1}')
    expect(first[0].backgroundWork!.kind).toBe('k')
    expect(second[0].backgroundWork!.kind).toBe('changed')
  })
})
