/**
 * Steer relocation in the grouping pass.
 *
 * A mid-turn steer is inserted optimistically where the user typed it, but the
 * engine applies it later and emits a "── Steer applied" divider at the point
 * it took effect. The grouping pass pairs the two via the shared
 * `steerAppliedDividerId` and re-emits the bubble directly AFTER its divider,
 * so the steer reads at its true moment of application instead of stranded
 * rows above the divider that announces it.
 *
 * These tests fail if the relocation logic in tool-helpers.ts is reverted:
 * without it the `user` item is emitted before the assistant/tool rows and the
 * divider, not after.
 */
import { describe, it, expect } from 'vitest'
import { groupMessages } from '../tool-helpers'
import type { GroupedItem } from '../tool-helpers'
import type { Message } from '../../../../shared/types'

const DIVIDER_ID = 'divider-1'

function steerBubble(overrides: Partial<Message> = {}): Message {
  return {
    id: 'steer-bubble',
    role: 'user',
    content: 'actually, check the other file first',
    timestamp: 1,
    steerApplied: true,
    steerAppliedDividerId: DIVIDER_ID,
    ...overrides,
  } as Message
}

function steerDivider(id = DIVIDER_ID): Message {
  return {
    id,
    role: 'system',
    content: '── Steer applied at 3:21 PM · 36 chars ──',
    timestamp: 4,
  } as Message
}

function assistantMsg(id: string, content = 'working on it'): Message {
  return { id, role: 'assistant', content, timestamp: 2 } as Message
}

function toolMsg(id: string): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: 'Read',
    toolId: id,
    toolStatus: 'completed',
    timestamp: 3,
  } as Message
}

/** Index of the grouped item carrying the given message id, or -1. */
function indexOfMessage(grouped: GroupedItem[], id: string): number {
  return grouped.findIndex(
    (item) => 'message' in item && item.message.id === id,
  )
}

describe.each([
  ['unified turn view', true],
  ['non-unified view', false],
])('steer relocation — %s', (_label, unifiedTurnView) => {
  const group = (messages: Message[]) =>
    groupMessages(messages, { includeUser: true, unifiedTurnView })

  it('emits the steer bubble immediately after its divider, not at its send position', () => {
    const grouped = group([
      steerBubble(),
      assistantMsg('a1'),
      toolMsg('t1'),
      steerDivider(),
    ])

    const dividerIdx = indexOfMessage(grouped, DIVIDER_ID)
    const steerIdx = indexOfMessage(grouped, 'steer-bubble')

    expect(dividerIdx).toBeGreaterThanOrEqual(0)
    expect(steerIdx).toBe(dividerIdx + 1)
  })

  it('renders the steer after the assistant text it interrupted', () => {
    const grouped = group([
      steerBubble(),
      assistantMsg('a1'),
      steerDivider(),
    ])

    const assistantIdx = indexOfMessage(grouped, 'a1')
    const steerIdx = indexOfMessage(grouped, 'steer-bubble')

    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    expect(steerIdx).toBeGreaterThan(assistantIdx)
  })

  it('keeps the bubble exactly once (relocated, never duplicated)', () => {
    const grouped = group([steerBubble(), assistantMsg('a1'), steerDivider()])
    const hits = grouped.filter(
      (item) => 'message' in item && item.message.id === 'steer-bubble',
    )
    expect(hits).toHaveLength(1)
  })

  it('pairs two steers each with its own divider', () => {
    const grouped = group([
      steerBubble({ id: 'steer-a', steerAppliedDividerId: 'div-a' }),
      assistantMsg('a1'),
      steerDivider('div-a'),
      steerBubble({ id: 'steer-b', steerAppliedDividerId: 'div-b' }),
      assistantMsg('a2'),
      steerDivider('div-b'),
    ])

    expect(indexOfMessage(grouped, 'steer-a')).toBe(indexOfMessage(grouped, 'div-a') + 1)
    expect(indexOfMessage(grouped, 'steer-b')).toBe(indexOfMessage(grouped, 'div-b') + 1)
  })

  it('leaves a still-pending steer (no divider yet) at its send position', () => {
    // steerPending bubbles carry no divider id — nothing to relocate to.
    const grouped = group([
      steerBubble({ steerApplied: undefined, steerAppliedDividerId: undefined, steerPending: true }),
      assistantMsg('a1'),
    ])

    expect(indexOfMessage(grouped, 'steer-bubble')).toBeLessThan(indexOfMessage(grouped, 'a1'))
  })

  it('never drops a steer whose divider never arrived', () => {
    // Engine died after stamping the pairing but the divider is not in the
    // visible window: the bubble must still be emitted, not swallowed.
    const grouped = group([steerBubble(), assistantMsg('a1')])
    expect(indexOfMessage(grouped, 'steer-bubble')).toBeGreaterThanOrEqual(0)
  })

  it('emits a normal user message in place (no relocation without the pairing)', () => {
    // Post-restart shape: the engine file carries the turn at its applied
    // position and the UI-only pairing fields are absent.
    const grouped = group([
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 } as Message,
      assistantMsg('a1'),
      steerDivider(),
    ])

    expect(indexOfMessage(grouped, 'u1')).toBeLessThan(indexOfMessage(grouped, 'a1'))
  })

  it('omits the relocated steer when includeUser is false', () => {
    const grouped = groupMessages([steerBubble(), assistantMsg('a1'), steerDivider()], {
      includeUser: false,
      unifiedTurnView,
    })
    expect(indexOfMessage(grouped, 'steer-bubble')).toBe(-1)
  })

  it('omits an orphaned steer when includeUser is false', () => {
    const grouped = groupMessages([steerBubble(), assistantMsg('a1')], {
      includeUser: false,
      unifiedTurnView,
    })
    expect(indexOfMessage(grouped, 'steer-bubble')).toBe(-1)
  })
})

describe('steer relocation — unified turn integrity', () => {
  it('does not split the agent turn at the steer send position', () => {
    // The steer landed mid-turn. Flushing the turn on it would break one
    // agent-turn into two around the point where the user happened to type.
    const grouped = groupMessages(
      [toolMsg('t1'), steerBubble(), toolMsg('t2'), steerDivider()],
      { includeUser: true, unifiedTurnView: true },
    )

    const turns = grouped.filter((item) => item.kind === 'agent-turn')
    expect(turns).toHaveLength(1)
    expect((turns[0] as { tools: Message[] }).tools.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})
