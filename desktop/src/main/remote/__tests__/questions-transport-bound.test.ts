import { describe, expect, it } from 'vitest'
import { fragmentPayload, reassemblePayload } from '../transport-fragmentation'
import { CRITICAL_TYPES, MAX_PLAINTEXT_BYTES } from '../transport-send'

describe('desktop_questions_state transport delivery', () => {
  it('is critical and fragments rather than depending on schema limits', () => {
    expect(CRITICAL_TYPES.has('desktop_questions_state')).toBe(true)
    expect(CRITICAL_TYPES.has('desktop_payload_chunk')).toBe(true)

    const event = {
      type: 'desktop_questions_state',
      tabId: 'tab-1',
      state: {
        workflows: [{
          workflowId: 'wf-1',
          requestId: 'req-1',
          sessionKey: 'tab-1',
          phase: 'collecting',
          request: {
            title: 'Large request',
            description: 'd'.repeat(MAX_PLAINTEXT_BYTES),
            questions: Array.from({ length: 40 }, (_, index) => ({
              id: `q-${index}`,
              prompt: `Question ${index}`,
              mode: 'text',
            })),
          },
          draft: [],
          history: [],
          revision: 1,
          startedAt: 1,
        }],
      },
    }
    const plaintext = JSON.stringify(event)
    const { chunks } = fragmentPayload(event.type, plaintext)
    expect(chunks.length).toBeGreaterThan(1)
    expect(reassemblePayload(chunks).toString('utf8')).toBe(plaintext)
  })
})
