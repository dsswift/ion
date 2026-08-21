// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { newestConversationMessageAt, resolveBackfilledMessageAt } from './useTabRestoration-activity'

describe('inbox message timestamp backfill', () => {
  it('uses only real user and assistant conversation messages', () => {
    expect(newestConversationMessageAt([
      { role: 'tool', content: 'late tool', timestamp: 900 },
      { role: 'user', content: 'scheduled', timestamp: 800, machineAuthored: true, injectionKind: 'checkin' },
      { role: 'assistant', content: 'real answer', timestamp: 700 },
      { role: 'user', content: 'real request', timestamp: 600 },
    ])).toBe(700)
  })

  it('keeps the newer persisted real-message timestamp', () => {
    expect(resolveBackfilledMessageAt(900, 700)).toBe(900)
    expect(resolveBackfilledMessageAt(null, 700)).toBe(700)
  })
})
