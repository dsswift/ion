/**
 * Structural transport bound for desktop_questions_state.
 *
 * The event is CRITICAL (never deliberately dropped) and has no lossy
 * degrader, so the schema limits in shared/questions-schema.ts must keep the
 * maximum valid canonical state under MAX_PLAINTEXT_BYTES. This test builds
 * the worst-case state the limits permit and asserts the serialized event
 * fits with generous headroom. If a future schema increase breaks the bound,
 * this fails loudly instead of the transport silently dropping draft data.
 */
import { describe, expect, it } from 'vitest'
import { MAX_PLAINTEXT_BYTES, CRITICAL_TYPES } from '../transport-send'
import { QUESTIONS_LIMITS } from '../../../shared/questions-schema'
import type { QuestionsStateSnapshot, QuestionsWorkflowState } from '../../../shared/questions-state'

/** Build one maximal workflow: every field at its limit. */
function maximalWorkflow(index: number): QuestionsWorkflowState {
  const L = QUESTIONS_LIMITS
  const text = (n: number) => 'x'.repeat(n)
  const questions = Array.from({ length: L.maxQuestionsPerPage }, (_, qi) => ({
    id: text(L.maxIdChars),
    prompt: text(L.maxPromptChars),
    guidance: text(L.maxGuidanceChars),
    mode: 'multiple' as const,
    display: 'checkbox' as const,
    options: Array.from({ length: L.maxOptionsPerQuestion }, (_, oi) => ({
      id: `${qi}-${oi}`.padEnd(L.maxIdChars, 'o'),
      label: text(L.maxOptionLabelChars),
      description: text(L.maxOptionDescriptionChars),
    })),
  }))
  const page = {
    title: text(L.maxTitleChars),
    answers: questions.map((q) => ({
      questionId: q.id,
      prompt: q.prompt,
      selectedOptionIds: q.options.map((o) => o.id),
      selectedLabels: q.options.map((o) => o.label),
      customText: text(L.maxFreeTextChars),
    })),
    comment: text(L.maxFreeTextChars),
  }
  return {
    workflowId: `wf-${index}`.padEnd(36, 'f'),
    requestId: `tool-gate-${index}`.padEnd(40, '0'),
    sessionKey: 'tab-' + text(32),
    phase: 'review',
    request: {
      title: text(L.maxTitleChars),
      description: text(L.maxDescriptionChars),
      workflowId: text(L.maxIdChars),
      questions,
    },
    draft: questions.map((q) => ({
      questionId: q.id,
      selectedOptionIds: q.options.map((o) => o.id),
      customText: text(L.maxFreeTextChars),
    })),
    comment: text(L.maxFreeTextChars),
    // A deep requestMore round: several full submitted pages of history.
    history: Array.from({ length: 8 }, () => page),
    revision: 999999,
    startedAt: Date.now(),
  }
}

describe('desktop_questions_state transport bound', () => {
  it('is registered critical (never deliberately dropped)', () => {
    expect(CRITICAL_TYPES.has('desktop_questions_state')).toBe(true)
  })

  it('the maximum valid state fits MAX_PLAINTEXT_BYTES with headroom', () => {
    // Several parallel maximal workflows on one session — the legal
    // multiple-open-calls case — all in one snapshot.
    const snapshot: QuestionsStateSnapshot = {
      workflows: [maximalWorkflow(0), maximalWorkflow(1), maximalWorkflow(2)],
      lastActionResult: { actionId: 'a'.repeat(64), accepted: false, error: 'e'.repeat(500) },
    }
    const event = { type: 'desktop_questions_state', tabId: 't'.repeat(36), state: snapshot }
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    // Require ≥25% headroom under the cap so schema growth trips this test
    // well before real payloads start being dropped at the gate.
    expect(bytes).toBeLessThan(MAX_PLAINTEXT_BYTES * 0.75)
  })
})
