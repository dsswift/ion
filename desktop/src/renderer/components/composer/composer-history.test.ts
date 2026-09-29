import { describe, expect, it } from 'vitest'
import type { Message } from '@ion/shared/types'
import { IDLE_HISTORY_CURSOR, promptHistoryFrom, stepHistory } from './composer-history'

const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id: content, role, content, ...extra } as Message)
const top = { onFirstLine: true, onLastLine: true }

describe('promptHistoryFrom', () => {
  it('keeps typed prompts only, collapsing immediate repeats', () => {
    const history = promptHistoryFrom([
      msg('user', 'first'),
      msg('assistant', 'reply'),
      msg('user', 'ls -la', { userExecuted: true }),
      msg('user', 'callback', { machineAuthored: true } as Partial<Message>),
      msg('user', 'second'),
      msg('user', 'second'),
    ])
    expect(history).toEqual(['first', 'second'])
  })
})

describe('stepHistory', () => {
  const history = ['first', 'second']

  it('walks back from an empty editor and forward to the saved draft', () => {
    const a = stepHistory(history, IDLE_HISTORY_CURSOR, '', 'back', top)!
    expect(a.text).toBe('second')
    const b = stepHistory(history, a.cursor, a.text, 'back', top)!
    expect(b.text).toBe('first')
    expect(stepHistory(history, b.cursor, b.text, 'back', top)).toBeNull()
    const c = stepHistory(history, b.cursor, b.text, 'forward', top)!
    expect(c.text).toBe('second')
    const d = stepHistory(history, c.cursor, c.text, 'forward', top)!
    expect(d).toEqual({ cursor: IDLE_HISTORY_CURSOR, text: '' })
  })

  it('detaches once the recalled text is edited', () => {
    const a = stepHistory(history, IDLE_HISTORY_CURSOR, '', 'back', top)!
    expect(stepHistory(history, a.cursor, 'second, edited', 'back', top)).toBeNull()
    expect(stepHistory(history, a.cursor, 'second, edited', 'forward', top)).toBeNull()
  })

  it('leaves the arrows to cursor movement in typed text and off the edge lines', () => {
    expect(stepHistory(history, IDLE_HISTORY_CURSOR, 'typing', 'back', top)).toBeNull()
    expect(stepHistory(history, IDLE_HISTORY_CURSOR, '', 'back', { onFirstLine: false, onLastLine: true })).toBeNull()
    expect(stepHistory(history, IDLE_HISTORY_CURSOR, '', 'forward', top)).toBeNull()
  })
})
