import { describe, expect, it } from 'vitest'
import {
  QUESTIONS_LIMITS,
  resolveQuestionDisplay,
  validateQuestionsRequest,
} from '../questions-schema'

// The display resolver is the shared desktop/iOS rule (plan: one
// deterministic rule pinned on both platforms). These cases are mirrored in
// the Swift QuestionsDisplayResolverTests — keep them in sync.
describe('resolveQuestionDisplay', () => {
  const opts = (n: number, described = false) =>
    Array.from({ length: n }, (_, i) => ({
      id: `o${i}`,
      label: `Option ${i}`,
      ...(described ? { description: 'why' } : {}),
    }))

  it('explicit valid hint wins', () => {
    expect(resolveQuestionDisplay({ mode: 'single', display: 'pills', options: opts(2) })).toBe('pills')
    expect(resolveQuestionDisplay({ mode: 'multiple', display: 'pills', options: opts(2) })).toBe('pills')
    expect(resolveQuestionDisplay({ mode: 'single', display: 'radio', options: opts(9) })).toBe('radio')
  })

  it('invalid hint for the mode falls through to the rule', () => {
    // checkbox is not a single-select control
    expect(resolveQuestionDisplay({ mode: 'single', display: 'checkbox', options: opts(2) })).toBe('radio')
    // radio is not a multi-select control
    expect(resolveQuestionDisplay({ mode: 'multiple', display: 'radio', options: opts(2) })).toBe('checkbox')
    expect(resolveQuestionDisplay({ mode: 'single', display: 'bogus', options: opts(2) })).toBe('radio')
  })

  it('more than five undescribed options resolve to pills', () => {
    expect(resolveQuestionDisplay({ mode: 'single', options: opts(6) })).toBe('pills')
    expect(resolveQuestionDisplay({ mode: 'multiple', options: opts(7) })).toBe('pills')
  })

  it('five or fewer options resolve to radio/checkbox', () => {
    expect(resolveQuestionDisplay({ mode: 'single', options: opts(5) })).toBe('radio')
    expect(resolveQuestionDisplay({ mode: 'multiple', options: opts(5) })).toBe('checkbox')
  })

  it('a described option forces radio/checkbox regardless of count', () => {
    expect(resolveQuestionDisplay({ mode: 'single', options: opts(8, true) })).toBe('radio')
    expect(resolveQuestionDisplay({ mode: 'multiple', options: opts(8, true) })).toBe('checkbox')
  })
})

describe('validateQuestionsRequest', () => {
  const valid = () => ({
    title: 'Scope check',
    questions: [
      {
        id: 'q1',
        prompt: 'Which storage backend?',
        mode: 'single',
        options: [
          { id: 'a', label: 'SQLite' },
          { id: 'b', label: 'Postgres' },
        ],
      },
      { id: 'q2', prompt: 'Anything else?', mode: 'text' },
    ],
  })

  it('accepts a valid request', () => {
    expect(validateQuestionsRequest(valid())).toBeNull()
  })

  it('rejects non-objects and missing title', () => {
    expect(validateQuestionsRequest(null)).toMatch(/object/)
    expect(validateQuestionsRequest('x')).toMatch(/object/)
    expect(validateQuestionsRequest({ questions: [] })).toMatch(/title/)
  })

  it('rejects empty and oversized question sets', () => {
    expect(validateQuestionsRequest({ title: 't', questions: [] })).toMatch(/non-empty/)
    const req = valid()
    req.questions = Array.from({ length: QUESTIONS_LIMITS.maxQuestionsPerPage + 1 }, (_, i) => ({
      id: `q${i}`, prompt: 'p', mode: 'text',
    })) as never
    expect(validateQuestionsRequest(req)).toMatch(/exceed/)
  })

  it('rejects duplicate question and option ids', () => {
    const req = valid()
    req.questions[1].id = 'q1'
    expect(validateQuestionsRequest(req)).toMatch(/duplicate id/)

    const req2 = valid()
    ;(req2.questions[0].options as { id: string }[])[1].id = 'a'
    expect(validateQuestionsRequest(req2)).toMatch(/duplicate option id/)
  })

  it('rejects option questions without options and text questions with options', () => {
    const noOpts = valid()
    delete (noOpts.questions[0] as Record<string, unknown>).options
    expect(validateQuestionsRequest(noOpts)).toMatch(/options are required/)

    const textWithOpts = valid()
    ;(textWithOpts.questions[1] as Record<string, unknown>).options = [{ id: 'x', label: 'X' }]
    expect(validateQuestionsRequest(textWithOpts)).toMatch(/takes no options/)
  })

  it('rejects a display hint invalid for the mode', () => {
    const req = valid()
    ;(req.questions[0] as Record<string, unknown>).display = 'checkbox'
    expect(validateQuestionsRequest(req)).toMatch(/display/)
  })

  it('rejects an invalid mode', () => {
    const req = valid()
    ;(req.questions[0] as Record<string, unknown>).mode = 'multi'
    expect(validateQuestionsRequest(req)).toMatch(/mode/)
  })
})
