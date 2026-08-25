/**
 * QuestionsCoordinator — the ONE owner of guided-questions workflow state.
 *
 * Lives in desktop main. Renderers (Overlay + Studio) and iOS hold
 * synchronized replicas; every mutation arrives as a revisioned patch or
 * action, is compare-and-set validated here, persisted, and fanned out.
 *
 * ── Park/resume architecture ────────────────────────────────────────────────
 * The engine PARKS on AskUserQuestions: the tool call terminates the run
 * with a retained PermissionDenial carrying the request (the AskUserQuestion
 * sentinel treatment), and the session goes idle. Nothing is running while
 * the user decides, so the question survives stop, tab navigation, desktop
 * restart, and engine restart — the engine re-publishes the retained denial
 * on every heartbeat/reconcile until a new prompt supersedes it, and this
 * coordinator persists the draft locally so typed answers survive too.
 *
 * The user's submission is NOT a tool result: it is a real prompt (built by
 * the wiring layer from the structured answers) that resumes the idle
 * conversation. requestMore rides the same prompt — the model is asked to
 * call AskUserQuestions again with the workflowId.
 *
 * State machine per workflow:
 *
 *   collecting → review → submitting → terminal(confirmed)
 *        ↑          |          |
 *        └── edit ──┘          └→ awaiting_next → collecting (next page)
 *
 * Key invariants:
 *   - Keyed by the denial's toolUseId (requestId field); workflowId is the
 *     stable identity across requestMore rounds and restarts.
 *   - A workflow is NEVER retired by stop, navigation, or reconnect. It
 *     retires only when its answer prompt is submitted (confirmed), when a
 *     DIFFERENT user prompt supersedes the parked question (superseded), or
 *     when the user explicitly cancels (cancel action).
 *   - Drafts persist on every accepted patch, so typed answers survive
 *     application and engine restart.
 */
import { randomUUID } from 'crypto'
import {
  validateQuestionsRequest,
  type QuestionsRequest,
  type QuestionsPageResult,
  QUESTIONS_LIMITS,
} from '../../shared/questions-schema'
import type {
  QuestionsAction,
  QuestionsActionResult,
  QuestionsPatch,
  QuestionsStateSnapshot,
  QuestionsTerminalReason,
  QuestionsWorkflowState,
} from '../../shared/questions-state'
import { persistWorkflow, removeWorkflowRecord, loadPersistedWorkflows } from './questions-persistence'
import { rehydrateFromTranscript, type TranscriptRow } from './questions-rehydrate'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'questions'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Submission sink: builds and sends the resume prompt for one submitted page.
 * Wired to the prompt pipeline (questions-wiring). Returns true when the
 * prompt was dispatched.
 */
export type QuestionsSubmitter = (workflow: QuestionsWorkflowState, requestMore: boolean) => boolean

/** One fan-out sink: broadcast to renderers + push to iOS. Injected. */
export type QuestionsFanout = (snapshot: QuestionsStateSnapshot, changed: QuestionsWorkflowState | undefined) => void

/** Optional per-request attention notification (APNs doorbell). Injected. */
export type QuestionsNotifier = (workflow: QuestionsWorkflowState) => void

export class QuestionsCoordinator {
  private workflows = new Map<string, QuestionsWorkflowState>() // workflowId → state
  private lastActionResult: QuestionsActionResult | undefined
  /** toolUseIds already notified, so heartbeat re-publishes don't re-ring. */
  private notifiedRequests = new Set<string>()

  constructor(
    private submitter: QuestionsSubmitter,
    private fanout: QuestionsFanout,
    private notifier?: QuestionsNotifier,
  ) {}

  /** Load persisted records before renderer hydration. Parked questions are
   *  durable by design: nothing is running while they wait, and submission
   *  is an ordinary prompt, so a restored workflow is immediately answerable
   *  with no engine confirmation required. handleIdleDenialsSnapshot retires
   *  any whose parked question the engine reports superseded. */
  restore(): void {
    for (const wf of loadPersistedWorkflows()) {
      // submitting/awaiting_next cannot survive a restart usefully: the
      // dispatch or continuation died with the process. Drop them; the
      // engine's retained denial (if any) re-opens a fresh workflow.
      if (wf.phase === 'submitting' || wf.phase === 'awaiting_next' || wf.phase === 'terminal') {
        removeWorkflowRecord(wf.workflowId)
        continue
      }
      this.workflows.set(wf.workflowId, wf)
      this.notifiedRequests.add(wf.requestId)
    }
    log('persisted workflows restored', { count: this.workflows.size })
  }

  /** The full synchronized snapshot (renderer hydration, iOS snapshot merge). */
  snapshot(): QuestionsStateSnapshot {
    return {
      workflows: [...this.workflows.values()],
      lastActionResult: this.lastActionResult,
    }
  }

  /** Open workflows for one TAB, oldest first (status/Inbox rules, snapshot
   *  merge). Matches by engine-key prefix: extension-hosted sessions key as
   *  `tabId:instanceId`. */
  openForSession(tabId: string): QuestionsWorkflowState[] {
    return [...this.workflows.values()]
      .filter((w) => {
        const wfTab = w.sessionKey.includes(':') ? w.sessionKey.slice(0, w.sessionKey.indexOf(':')) : w.sessionKey
        return wfTab === tabId && w.phase !== 'terminal'
      })
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  // ── Engine-facing entry points ─────────────────────────────────────────────

  /**
   * A parked AskUserQuestions denial arrived (task_complete or an idle
   * engine_status re-publishing retained denials). Idempotent per
   * toolUseId: the engine re-publishes the same denial on every heartbeat,
   * so an existing workflow for the id is left untouched — including its
   * draft. Malformed input opens no workflow (the model gets its error from
   * the resume prompt path never firing; the run already ended).
   */
  handleParkedQuestion(sessionKey: string, toolUseId: string, input: Record<string, unknown>): void {
    // Idempotency: the same parked question re-announced.
    for (const wf of this.workflows.values()) {
      if (wf.requestId === toolUseId && wf.phase !== 'terminal') return
    }

    const validationError = validateQuestionsRequest(input)
    if (validationError) {
      warn('parked question has malformed input; no workflow opened', {
        session_key: sessionKey, tool_use_id: toolUseId.slice(0, 16), error: validationError,
      })
      return
    }
    const request = input as unknown as QuestionsRequest

    // Continuation: the model called again with a workflowId we returned.
    // Only an awaiting_next workflow with that EXACT id attaches; anything
    // else starts a new workflow and never inherits old answers.
    const existing = request.workflowId ? this.workflows.get(request.workflowId) : undefined
    if (existing && existing.phase === 'awaiting_next' && existing.sessionKey === sessionKey) {
      existing.requestId = toolUseId
      existing.request = request
      existing.draft = request.questions.map((q) => ({ questionId: q.id, selectedOptionIds: [] }))
      existing.comment = undefined
      existing.phase = 'collecting'
      existing.revision++
      existing.startedAt = Date.now()
      log('continuation page attached', {
        session_key: sessionKey, workflow_id: existing.workflowId, tool_use_id: toolUseId.slice(0, 16),
      })
      this.commit(existing)
      return
    }

    const workflow: QuestionsWorkflowState = {
      workflowId: randomUUID(),
      requestId: toolUseId,
      sessionKey,
      phase: 'collecting',
      request,
      draft: request.questions.map((q) => ({ questionId: q.id, selectedOptionIds: [] })),
      history: [],
      revision: 1,
      startedAt: Date.now(),
    }
    this.workflows.set(workflow.workflowId, workflow)
    log('workflow opened from parked question', {
      session_key: sessionKey, workflow_id: workflow.workflowId,
      tool_use_id: toolUseId.slice(0, 16), questions: request.questions.length, title: request.title,
    })
    this.commit(workflow)
    if (!this.notifiedRequests.has(toolUseId)) {
      this.notifiedRequests.add(toolUseId)
      this.notifier?.(workflow)
    }
  }

  /**
   * An IDLE engine_status snapshot for a session arrived; retainedToolUseIds
   * are the AskUserQuestions denials it still carries. Used to retire a
   * workflow whose parked question was superseded by a prompt from another
   * client while this desktop was not watching.
   *
   * `sawDenialEvidence` is the guard that makes this safe. An idle snapshot
   * with NO denials is ambiguous: it means either "the question is gone" or
   * "this session was just re-registered and has not re-published its
   * retained state yet". The desktop re-registers every session on reconnect
   * and on launch, so treating the empty case as authoritative destroyed live
   * workflows — including their persisted records — every time the app
   * restarted. That was the "questions panel missing after reinstall"
   * defect: the record was not failing to persist, it was being deleted on
   * the way back up.
   *
   * So retirement requires POSITIVE evidence: the snapshot must carry at
   * least one AskUserQuestions denial for this session (proving the engine
   * re-published its retained state) while omitting ours. Absent that, the
   * workflow is left alone — a stale card the user can dismiss is strictly
   * better than silently destroying answers they typed.
   */
  handleIdleDenialsSnapshot(sessionKey: string, retainedToolUseIds: Set<string>, sawDenialEvidence: boolean): void {
    if (!sawDenialEvidence) return
    for (const wf of this.workflows.values()) {
      if (wf.sessionKey !== sessionKey) continue
      if (wf.phase !== 'collecting' && wf.phase !== 'review') continue
      if (retainedToolUseIds.has(wf.requestId)) continue
      log('workflow retired: engine no longer retains its parked question', {
        workflow_id: wf.workflowId, session_key: sessionKey,
      })
      this.retire(wf, 'superseded')
    }
  }

  /**
   * Rebuild a workflow from the conversation transcript when one is not
   * already live for this session.
   *
   * The transcript — not the ~/.ion/questions cache — is the authority for
   * whether a question is outstanding. The cache holds the operator's typed
   * draft; the transcript holds the question itself, persisted by the engine
   * as an ordinary tool call. This is the same durability the single-question
   * card has always had (shared/pending-card.ts), which is why that card
   * survives restarts and a wiped cache while Guided Questions did not.
   *
   * Idempotent and non-destructive: a live workflow for the same toolUseId
   * wins (it may carry a draft the transcript cannot know about), and a
   * transcript with no outstanding question changes nothing.
   *
   * Returns true when a workflow was opened from the transcript.
   */
  rehydrateFromRows(sessionKey: string, rows: readonly TranscriptRow[]): boolean {
    // A live workflow already covers this session — never clobber a draft.
    for (const wf of this.workflows.values()) {
      if (wf.sessionKey === sessionKey && wf.phase !== 'terminal') return false
    }

    const outcome = rehydrateFromTranscript(rows)
    if (outcome.kind !== 'found') {
      log('transcript rehydrate: no parked question', {
        session_key: sessionKey, outcome: outcome.kind,
        ...(outcome.kind === 'malformed' ? { error: outcome.error } : {}),
      })
      return false
    }

    const { toolUseId, request } = outcome.question
    const workflow: QuestionsWorkflowState = {
      workflowId: randomUUID(),
      requestId: toolUseId,
      sessionKey,
      phase: 'collecting',
      request,
      draft: request.questions.map((q) => ({ questionId: q.id, selectedOptionIds: [] })),
      history: [],
      revision: 1,
      startedAt: Date.now(),
    }
    this.workflows.set(workflow.workflowId, workflow)
    this.notifiedRequests.add(toolUseId)
    log('workflow rehydrated from transcript', {
      session_key: sessionKey, workflow_id: workflow.workflowId,
      tool_use_id: toolUseId.slice(0, 16), questions: request.questions.length, title: request.title,
    })
    this.commit(workflow)
    return true
  }

  /**
   * A prompt was dispatched on the tab. Two meanings:
   *   - fromQuestions: our own resume prompt — the submitting workflow
   *     completes (terminal confirmed) or advances to awaiting_next.
   *   - otherwise: the user typed something else — the parked question is
   *     SUPERSEDED (the engine clears its retained denial on any new
   *     prompt, so the question can no longer resume; retiring matches the
   *     AskUserQuestion card's lifetime exactly).
   *
   * tabId matches by ENGINE-KEY PREFIX: workflows key on the engine session
   * key (`tabId` or `tabId:instanceId`), while the pipeline reports the tab.
   */
  handlePromptDispatched(tabId: string, fromQuestions: boolean): void {
    for (const wf of this.workflows.values()) {
      const wfTab = wf.sessionKey.includes(':') ? wf.sessionKey.slice(0, wf.sessionKey.indexOf(':')) : wf.sessionKey
      if (wfTab !== tabId || wf.phase === 'terminal') continue
      if (fromQuestions && wf.phase === 'submitting') {
        if (wf.pendingRequestMore) {
          wf.phase = 'awaiting_next'
          wf.pendingRequestMore = undefined
          wf.revision++
          log('submission dispatched; awaiting continuation page', { workflow_id: wf.workflowId })
          this.commit(wf)
        } else {
          this.retire(wf, 'confirmed')
        }
        continue
      }
      if (!fromQuestions && (wf.phase === 'collecting' || wf.phase === 'review')) {
        this.retire(wf, 'superseded')
      }
      if (!fromQuestions && wf.phase === 'awaiting_next') {
        // A foreign prompt while awaiting the continuation call: the round
        // is abandoned by the user's own action.
        this.retire(wf, 'superseded')
      }
    }
  }

  /**
   * A run ended without producing the awaited continuation call. Fail the
   * awaiting_next workflow so its loading state clears. Deliberately does
   * NOT touch collecting/review workflows: parked questions outlive run
   * exits by design.
   */
  handleRunIdle(sessionKey: string): void {
    for (const wf of this.workflows.values()) {
      if (wf.sessionKey !== sessionKey || wf.phase !== 'awaiting_next') continue
      // The model finished its turn WITHOUT calling AskUserQuestions again,
      // so the deeper page the operator asked for never arrived.
      //
      // Retiring here destroyed the round: the operator's submitted answers
      // and their explicit "ask me more" both vanished, and the panel simply
      // disappeared. A model that forgets to call a tool must never cost the
      // operator work they already did.
      //
      // Return the workflow to review instead. The page they submitted is
      // still in history, their draft is intact, and Confirm & send or a
      // second "ask me more" both remain available — the round is recoverable
      // by the operator rather than deleted on their behalf.
      wf.phase = 'review'
      wf.pendingRequestMore = undefined
      wf.revision++
      warn('continuation page never arrived; restored the round to review', {
        workflow_id: wf.workflowId, session_key: sessionKey, pages_submitted: wf.history.length,
      })
      this.commit(wf)
    }
  }

  // ── Client-facing mutations (revisioned) ───────────────────────────────────

  /** Apply a draft patch. Returns the action result; always fans out. */
  applyPatch(patch: QuestionsPatch): QuestionsActionResult {
    const wf = this.validateMutation(patch.workflowId, patch.requestId, patch.expectedRevision, patch.actionId)
    if ('error' in wf) return this.reject(patch.actionId, wf.error, wf.workflow)
    const state = wf.workflow
    if (state.phase !== 'collecting' && state.phase !== 'review') {
      return this.reject(patch.actionId, `patch not allowed in phase ${state.phase}`, state)
    }
    if (patch.answers) {
      for (const answer of patch.answers) {
        const spec = state.request.questions.find((q) => q.id === answer.questionId)
        if (!spec) return this.reject(patch.actionId, `unknown question ${answer.questionId}`, state)
        const validIds = new Set((spec.options ?? []).map((o) => o.id))
        if (answer.selectedOptionIds.some((id) => !validIds.has(id))) {
          return this.reject(patch.actionId, `invalid option id on ${answer.questionId}`, state)
        }
        if (spec.mode === 'single' && answer.selectedOptionIds.length > 1) {
          return this.reject(patch.actionId, `single-select ${answer.questionId} got multiple selections`, state)
        }
        if ((answer.customText ?? '').length > QUESTIONS_LIMITS.maxFreeTextChars) {
          return this.reject(patch.actionId, `text on ${answer.questionId} exceeds bound`, state)
        }
        const idx = state.draft.findIndex((d) => d.questionId === answer.questionId)
        if (idx >= 0) state.draft[idx] = { ...answer }
        else state.draft.push({ ...answer })
      }
    }
    if (patch.comment !== undefined) {
      if (patch.comment.length > QUESTIONS_LIMITS.maxFreeTextChars) {
        return this.reject(patch.actionId, 'comment exceeds bound', state)
      }
      state.comment = patch.comment || undefined
    }
    state.revision++
    this.lastActionResult = { actionId: patch.actionId, accepted: true }
    this.commit(state)
    return this.lastActionResult
  }

  /**
   * Apply a workflow action. Submit-bearing actions (request_more,
   * final_confirm) accept an inline final draft (action.answers/comment via
   * the patch fields on QuestionsAction) — no: submit actions read the
   * CURRENT accepted draft; the wizard flushes its patch first and this
   * method applies atomically in ONE revision step, which is what fixes the
   * "Review answers did nothing" CAS race (patch and action can no longer
   * disagree about the revision).
   */
  applyAction(action: QuestionsAction): QuestionsActionResult {
    const wf = this.validateMutation(action.workflowId, action.requestId, action.expectedRevision, action.actionId)
    if ('error' in wf) return this.reject(action.actionId, wf.error, wf.workflow)
    const state = wf.workflow

    // Inline final draft: a submit/transition action may carry the caller's
    // final answers so the draft+transition lands in one atomic revision
    // step. Validated with the same rules as a patch.
    if (action.answers || action.comment !== undefined) {
      const inlineErr = this.applyInlineDraft(state, action)
      if (inlineErr) return this.reject(action.actionId, inlineErr, state)
    }

    switch (action.kind) {
      case 'enter_review':
        if (state.phase !== 'collecting') return this.reject(action.actionId, `enter_review in phase ${state.phase}`, state)
        state.phase = 'review'
        break
      case 'edit_question':
        if (state.phase !== 'review') return this.reject(action.actionId, `edit_question in phase ${state.phase}`, state)
        state.phase = 'collecting'
        break
      case 'request_more':
        if (state.phase !== 'collecting' && state.phase !== 'review') {
          return this.reject(action.actionId, `request_more in phase ${state.phase}`, state)
        }
        return this.submit(state, action.actionId, true)
      case 'final_confirm':
        if (state.phase !== 'review' && state.phase !== 'collecting') {
          return this.reject(action.actionId, `final_confirm in phase ${state.phase}`, state)
        }
        return this.submit(state, action.actionId, false)
      case 'cancel':
        // Explicit user cancel: the parked question is abandoned. The
        // engine's retained denial clears on the next prompt; nothing is
        // running, so no engine message is needed.
        this.retire(state, 'cancelled')
        this.lastActionResult = { actionId: action.actionId, accepted: true }
        return this.lastActionResult
    }
    state.revision++
    this.lastActionResult = { actionId: action.actionId, accepted: true }
    this.commit(state)
    return this.lastActionResult
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private applyInlineDraft(state: QuestionsWorkflowState, action: QuestionsAction): string | null {
    if (action.answers) {
      for (const answer of action.answers) {
        const spec = state.request.questions.find((q) => q.id === answer.questionId)
        if (!spec) return `unknown question ${answer.questionId}`
        const validIds = new Set((spec.options ?? []).map((o) => o.id))
        if (answer.selectedOptionIds.some((id) => !validIds.has(id))) return `invalid option id on ${answer.questionId}`
        if (spec.mode === 'single' && answer.selectedOptionIds.length > 1) return `single-select ${answer.questionId} got multiple selections`
        if ((answer.customText ?? '').length > QUESTIONS_LIMITS.maxFreeTextChars) return `text on ${answer.questionId} exceeds bound`
        const idx = state.draft.findIndex((d) => d.questionId === answer.questionId)
        if (idx >= 0) state.draft[idx] = { ...answer }
        else state.draft.push({ ...answer })
      }
    }
    if (action.comment !== undefined) {
      if (action.comment.length > QUESTIONS_LIMITS.maxFreeTextChars) return 'comment exceeds bound'
      state.comment = action.comment || undefined
    }
    return null
  }

  /**
   * Build the page result from the accepted draft and dispatch the resume
   * prompt through the submitter (the prompt pipeline). One atomic revision
   * step: phase flips to submitting, persistence lands before dispatch, and
   * handlePromptDispatched(fromQuestions=true) completes the lifecycle.
   */
  private submit(state: QuestionsWorkflowState, actionId: string, requestMore: boolean): QuestionsActionResult {
    const page: QuestionsPageResult = {
      title: state.request.title,
      answers: state.request.questions.map((q) => {
        const draft = state.draft.find((d) => d.questionId === q.id)
        const selected = draft?.selectedOptionIds ?? []
        const labels = selected.map((id) => q.options?.find((o) => o.id === id)?.label ?? id)
        const answered = selected.length > 0 || !!draft?.customText
        return {
          questionId: q.id,
          prompt: q.prompt,
          selectedOptionIds: selected,
          selectedLabels: labels,
          customText: draft?.customText,
          skipped: draft?.skipped || !answered || undefined,
          attachments: draft?.attachments,
        }
      }),
      comment: state.comment,
    }
    // Remember where to return to if the dispatch fails. Hardcoding 'review'
    // here silently MOVED the user: a failed "Ask me more questions" from the
    // collecting page landed them on the review screen, which read as the
    // button doing the wrong thing rather than as a failure.
    const phaseBeforeSubmit = state.phase
    state.history = [...state.history, page]
    state.phase = 'submitting'
    state.pendingRequestMore = requestMore || undefined
    state.revision++
    // Outbox-before-send: persist the submitting state first so a restart
    // between persist and dispatch shows the true phase.
    persistWorkflow(state)

    const dispatched = this.submitter(state, requestMore)
    if (!dispatched) {
      // The dispatch was refused (no sink, pipeline unavailable). Return to
      // the EXACT page the user acted from; the draft is intact.
      state.phase = phaseBeforeSubmit
      state.pendingRequestMore = undefined
      state.history = state.history.slice(0, -1)
      state.revision++
      warn('resume prompt dispatch failed; restored pre-submit phase', {
        workflow_id: state.workflowId, phase: phaseBeforeSubmit,
      })
      this.lastActionResult = { actionId, accepted: false, error: 'submission failed; try again' }
      this.commit(state)
      return this.lastActionResult
    }
    log('answers submitted as resume prompt', {
      workflow_id: state.workflowId, request_more: requestMore, pages: state.history.length,
    })
    this.lastActionResult = { actionId, accepted: true }
    this.commit(state)
    return this.lastActionResult
  }

  private validateMutation(
    workflowId: string,
    requestId: string,
    expectedRevision: number,
    actionId: string,
  ): { workflow: QuestionsWorkflowState } | { error: string; workflow?: QuestionsWorkflowState } {
    const state = this.workflows.get(workflowId)
    if (!state) return { error: `unknown workflow ${workflowId}` }
    if (state.requestId !== requestId) return { error: 'stale request id', workflow: state }
    if (state.revision !== expectedRevision) return { error: `stale revision ${expectedRevision} (now ${state.revision})`, workflow: state }
    if (!actionId) return { error: 'actionId is required', workflow: state }
    return { workflow: state }
  }

  private reject(actionId: string, error: string, state?: QuestionsWorkflowState): QuestionsActionResult {
    warn('mutation rejected', { action_id: actionId, error })
    this.lastActionResult = { actionId, accepted: false, error }
    // Fan out the authoritative state so the rejecting client rolls back.
    if (state) this.commit(state, /*persist*/ false)
    else this.fanout(this.snapshot(), undefined)
    return this.lastActionResult
  }

  private retire(state: QuestionsWorkflowState, reason: QuestionsTerminalReason): void {
    state.phase = 'terminal'
    state.terminalReason = reason
    state.revision++
    removeWorkflowRecord(state.workflowId)
    log('workflow retired', { workflow_id: state.workflowId, reason })
    this.fanout(this.snapshot(), state)
    // Terminal states are broadcast once for dismissal, then dropped.
    this.workflows.delete(state.workflowId)
  }

  private commit(state: QuestionsWorkflowState, persist = true): void {
    // A terminal workflow never re-persists: retire() already removed its
    // record, and the submitter can complete a workflow SYNCHRONOUSLY (the
    // pipeline's dispatch observer runs inside the submit call), so this
    // commit may observe a state that retired mid-flight.
    if (persist && state.phase !== 'terminal') persistWorkflow(state)
    this.fanout(this.snapshot(), state)
  }
}
