/**
 * Guided Questions contract — the AskUserQuestions client-tool schema.
 *
 * The desktop declares the `AskUserQuestions` client tool on every engine
 * session (tool-gate-responder.ts) with humanWait: true. The model calls it
 * with a QuestionsRequest (one page of structured questions); the desktop
 * renders the wizard, collects answers, and returns a QuestionsResult as the
 * tool result. The engine is transport only: it carries the call, suspends
 * its deadlines for the human wait, and routes the response.
 *
 * This file owns the request/result shapes, the validation limits, and the
 * deterministic display-hint resolver shared by desktop and iOS. Anything
 * here is desktop-owned contract (ADR 008): iOS mirrors these shapes in
 * Swift, and the resolver rule is pinned by unit tests on both platforms so
 * the same request renders the same control everywhere.
 */

/** Selection mode of one question. */
export type QuestionMode = 'single' | 'multiple' | 'text'

/**
 * Rendering hint for an option question. Changes rendering only — never the
 * answer contract. Absent/unknown values resolve via resolveQuestionDisplay.
 */
export type QuestionDisplay = 'radio' | 'checkbox' | 'pills'

/** One selectable option. IDs are stable within the question. */
export interface QuestionOption {
  id: string
  label: string
  /** Optional per-option trade-off / explanation shown with the option. */
  description?: string
}

/** One question on a page. */
export interface QuestionSpec {
  /** Stable within the request; answers reference it. */
  id: string
  prompt: string
  /** Optional longer guidance rendered under the prompt. */
  guidance?: string
  mode: QuestionMode
  /**
   * Rendering hint. Valid combinations: single → radio|pills,
   * multiple → checkbox|pills. Ignored for mode "text".
   */
  display?: QuestionDisplay
  /** Options; required for single/multiple, absent for text. */
  options?: QuestionOption[]
}

/** The AskUserQuestions tool input: one page of questions. */
export interface QuestionsRequest {
  title: string
  /** Optional evidence summary / context for the page. */
  description?: string
  /**
   * Continuation identity. The FIRST call of a workflow omits it; the
   * desktop mints one and returns it on every result. A follow-up page
   * (after requestMore) must carry the returned id — an absent or different
   * id starts a NEW workflow and never inherits old answers.
   */
  workflowId?: string
  questions: QuestionSpec[]
}

/** One answered question in the result. */
export interface QuestionAnswer {
  questionId: string
  /** The prompt echoed verbatim so the transcript is self-describing. */
  prompt: string
  /** Selected option IDs (empty for text questions and skips). */
  selectedOptionIds: string[]
  /** Selected option labels, parallel to selectedOptionIds. */
  selectedLabels: string[]
  /** Free-form text: the Other input, or the text-mode answer. */
  customText?: string
  /** True when the user explicitly skipped ("Agent decides"). */
  skipped?: boolean
  /** Images the user attached to this answer (paths on the desktop host;
   *  the actual bytes ride the resume prompt's attachment pipeline). */
  attachments?: Array<{ path: string; name: string }>
}

/** One submitted page in the result (workflows can span several). */
export interface QuestionsPageResult {
  title: string
  answers: QuestionAnswer[]
  /** The page-level free-form comment, when the user wrote one. */
  comment?: string
}

/** The AskUserQuestions tool result payload (serialized as the tool result). */
export interface QuestionsResult {
  workflowId: string
  /** Every submitted page, oldest first — the full answer history. */
  pages: QuestionsPageResult[]
  /**
   * True when the user chose "Ask me more questions": the model must call
   * AskUserQuestions again with this workflowId to continue the round.
   * False on final confirmation: the workflow is complete.
   */
  requestMore: boolean
}

// ── Outbound answer limit ───────────────────────────────────────────────────
// Request content comes FROM the agent and is accepted without receiver-side
// size limits. User-authored free text flows back TO the agent, so that one
// downstream boundary stays bounded.

export const QUESTIONS_LIMITS = {
  /** Custom text / page comment cap (user input, enforced by the UI too). */
  maxFreeTextChars: 4000,
} as const

/**
 * Resolve the effective display control for an option question.
 *
 * One deterministic rule shared by desktop and iOS (both pin it with unit
 * tests): an explicit valid hint wins; otherwise use pills when the question
 * has MORE THAN FIVE options and none of them carries a description
 * (compact quick-pick), else radio (single) / checkbox (multiple) — the
 * denser controls that give descriptions room. Text-mode questions have no
 * control to resolve; callers must not ask.
 */
export function resolveQuestionDisplay(q: {
  mode: QuestionMode
  display?: string
  options?: QuestionOption[]
}): QuestionDisplay {
  const valid: Record<Exclude<QuestionMode, 'text'>, QuestionDisplay[]> = {
    single: ['radio', 'pills'],
    multiple: ['checkbox', 'pills'],
  }
  if (q.mode === 'text') {
    // Defensive: a text question renders a text field; callers should not
    // reach here, but a stable answer beats a throw in render paths.
    return 'radio'
  }
  if (q.display && (valid[q.mode] as string[]).includes(q.display)) {
    return q.display as QuestionDisplay
  }
  const options = q.options ?? []
  const anyDescribed = options.some((o) => !!o.description)
  if (options.length > 5 && !anyDescribed) return 'pills'
  return q.mode === 'single' ? 'radio' : 'checkbox'
}

/**
 * Validate a QuestionsRequest against the schema and limits. Returns null
 * when valid, or a human-readable error string (returned to the model as a
 * tool error) naming the first violation.
 */
export function validateQuestionsRequest(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return 'request must be an object'
  const req = input as Record<string, unknown>

  const title = req.title
  if (typeof title !== 'string' || title.length === 0) return 'title is required'
  if (req.description !== undefined && typeof req.description !== 'string') {
    return 'description must be a string'
  }
  if (req.workflowId !== undefined && (typeof req.workflowId !== 'string' || req.workflowId.length === 0)) {
    return 'workflowId must be a non-empty string'
  }

  const questions = req.questions
  if (!Array.isArray(questions) || questions.length === 0) return 'questions must be a non-empty array'

  const seenIds = new Set<string>()
  for (const [i, raw] of questions.entries()) {
    if (typeof raw !== 'object' || raw === null) return `question ${i} must be an object`
    const q = raw as Record<string, unknown>
    if (typeof q.id !== 'string' || q.id.length === 0) return `question ${i}: id is required`
    if (seenIds.has(q.id)) return `question ${i}: duplicate id ${q.id}`
    seenIds.add(q.id)
    if (typeof q.prompt !== 'string' || q.prompt.length === 0) return `question ${q.id}: prompt is required`
    if (q.guidance !== undefined && typeof q.guidance !== 'string') {
      return `question ${q.id}: guidance must be a string`
    }
    if (q.mode !== 'single' && q.mode !== 'multiple' && q.mode !== 'text') return `question ${q.id}: mode must be single, multiple, or text`

    if (q.mode === 'text') {
      if (q.options !== undefined && Array.isArray(q.options) && q.options.length > 0) return `question ${q.id}: text mode takes no options`
      continue
    }

    const options = q.options
    if (!Array.isArray(options) || options.length === 0) return `question ${q.id}: options are required for ${String(q.mode)} mode`
    const seenOptionIds = new Set<string>()
    for (const [j, rawOpt] of options.entries()) {
      if (typeof rawOpt !== 'object' || rawOpt === null) return `question ${q.id}: option ${j} must be an object`
      const o = rawOpt as Record<string, unknown>
      if (typeof o.id !== 'string' || o.id.length === 0) return `question ${q.id}: option ${j} id is required`
      if (seenOptionIds.has(o.id)) return `question ${q.id}: duplicate option id ${o.id}`
      seenOptionIds.add(o.id)
      if (typeof o.label !== 'string' || o.label.length === 0) return `question ${q.id}: option ${o.id} label is required`
      if (o.description !== undefined && typeof o.description !== 'string') {
        return `question ${q.id}: option ${o.id} description must be a string`
      }
    }
    if (q.display !== undefined) {
      const validDisplays = q.mode === 'single' ? ['radio', 'pills'] : ['checkbox', 'pills']
      if (typeof q.display !== 'string' || !validDisplays.includes(q.display)) return `question ${q.id}: display must be one of ${validDisplays.join(', ')} for ${String(q.mode)} mode`
    }
  }

  return null
}
