import { describe, expect, it } from 'vitest'
import { formatConversationTranscript } from '../conversation-transcript'

describe('formatConversationTranscript', () => {
  it('formats non-empty user and assistant rows exactly', () => {
    expect(formatConversationTranscript([
      { role: 'system', content: 'hidden' },
      { role: 'user', content: 'Hello' },
      { role: 'tool', content: 'ignored' },
      { role: 'assistant', content: 'World' },
      { role: 'assistant', content: '   ' },
    ])).toBe('[user]: Hello\n\n[assistant]: World')
  })

  it('returns an empty string when no transcript rows exist', () => {
    expect(formatConversationTranscript([{ role: 'tool', content: 'result' }])).toBe('')
  })
})
