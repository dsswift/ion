/**
 * Transcript-derived rehydration for Guided Questions.
 *
 * A parked question lives in the conversation transcript, which the engine
 * persists like any other tool call. The ~/.ion/questions record caches the
 * operator's typed DRAFT; it is not the authority for whether a question
 * exists. These tests pin that separation — the defect they close is a
 * reinstall (and a reconnect bug that wiped the cache) leaving a conversation
 * whose last tool call was AskUserQuestions with no panel at all.
 */
import { describe, it, expect } from 'vitest'
import { rehydrateFromTranscript, type TranscriptRow } from './questions-rehydrate'

const REQUEST = {
  title: 'COS2 briefing schedule choices',
  questions: [
    { id: 'q1', prompt: 'Which cadence?', mode: 'single', options: [{ id: 'a', label: 'Daily' }] },
    { id: 'q2', prompt: 'Anything else?', mode: 'text' },
  ],
}

function questionRow(overrides: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    role: 'assistant',
    toolName: 'AskUserQuestions',
    toolId: 'call_X30Hgg6Al6ScqSs59GTd8XPV',
    toolInput: JSON.stringify(REQUEST),
    ...overrides,
  }
}

describe('rehydrateFromTranscript — recovering a parked question', () => {
  it('finds the question when it is the last tool call', () => {
    const outcome = rehydrateFromTranscript([
      { role: 'user', content: 'set up the briefing' },
      { role: 'assistant', toolName: 'Bash', toolId: 'call_b', toolInput: '{}' },
      questionRow(),
    ])

    expect(outcome.kind).toBe('found')
    if (outcome.kind !== 'found') return
    expect(outcome.question.toolUseId).toBe('call_X30Hgg6Al6ScqSs59GTd8XPV')
    expect(outcome.question.request.title).toBe('COS2 briefing schedule choices')
    expect(outcome.question.request.questions).toHaveLength(2)
  })

  it('accepts a toolInput already parsed into an object', () => {
    // Different history sources hand the input over in different shapes; a
    // question must not vanish because of which one a caller used.
    const outcome = rehydrateFromTranscript([
      questionRow({ toolInput: REQUEST as unknown as string }),
    ])
    expect(outcome.kind).toBe('found')
  })
})

describe('rehydrateFromTranscript — when NOT to restore', () => {
  it('a user turn after the question means it was answered', () => {
    const outcome = rehydrateFromTranscript([questionRow(), { role: 'user', content: 'my answers' }])
    expect(outcome.kind).toBe('suppressed-by-user')
  })

  it('a /clear divider dismisses the question', () => {
    const outcome = rehydrateFromTranscript([
      questionRow(),
      { role: 'system', content: '── Cleared · 12 messages' },
    ])
    expect(outcome.kind).toBe('suppressed-by-clear')
  })

  it('a later non-question tool call means the run moved on', () => {
    const outcome = rehydrateFromTranscript([
      questionRow(),
      { role: 'assistant', toolName: 'Bash', toolId: 'call_b', toolInput: '{}' },
    ])
    expect(outcome.kind).toBe('none')
  })

  it('an empty or absent transcript restores nothing', () => {
    expect(rehydrateFromTranscript([]).kind).toBe('none')
    expect(rehydrateFromTranscript(null).kind).toBe('none')
  })

  it('a MACHINE-authored turn after the question does NOT count as answering it', () => {
    // An agent callback or background-task result landing after the question
    // is not the operator answering; treating it as one would silently drop
    // a question the operator still owes.
    const outcome = rehydrateFromTranscript([
      questionRow(),
      { role: 'user', content: '[dev-lead] done', injectionKind: 'agent_completion', machineAuthored: true },
    ])
    expect(outcome.kind).toBe('found')
  })
})

describe('rehydrateFromTranscript — malformed input opens nothing', () => {
  it('rejects a question row with unparseable toolInput', () => {
    const outcome = rehydrateFromTranscript([questionRow({ toolInput: '{not json' })])
    expect(outcome.kind).toBe('malformed')
  })

  it('rejects a request that fails schema validation', () => {
    // The same validator the live intake uses: a transcript row is not more
    // trusted than a live tool call.
    const outcome = rehydrateFromTranscript([
      questionRow({ toolInput: JSON.stringify({ title: 'no questions array' }) }),
    ])
    expect(outcome.kind).toBe('malformed')
  })

  it('rejects a question row with no toolId to correlate against', () => {
    const outcome = rehydrateFromTranscript([questionRow({ toolId: undefined })])
    expect(outcome.kind).toBe('malformed')
  })
})
