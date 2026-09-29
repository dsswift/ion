/**
 * Guided Questions workflow state — the main-owned QuestionsCoordinator's
 * canonical projection, consumed by both desktop renderers (via IPC/broadcast)
 * and iOS (via desktop_questions_state / RemoteTabState.questions).
 *
 * Main is the ONLY workflow owner. Renderers and iOS hold synchronized
 * replicas: every mutation is a revisioned patch/action sent to main, and the
 * authoritative state comes back through one fan-out. `revision` is the
 * compare-and-set token — a client that patches with a stale
 * expectedRevision receives the canonical state and rolls back.
 */
import type { QuestionsRequest, QuestionsPageResult } from './questions-schema'

/** Workflow lifecycle phase. */
export type QuestionsPhase =
  /** Collecting answers on the current page. */
  | 'collecting'
  /** Reviewing the drafted answers before final confirmation. */
  | 'review'
  /** Response sent to the engine; awaiting proof the request is gone. */
  | 'submitting'
  /** requestMore sent; run continues; awaiting the next page's tool call. */
  | 'awaiting_next'
  /** Finished (confirmed, cancelled, superseded, or failed). */
  | 'terminal'

/** Why a workflow reached terminal (rendering hint; no behavior). */
export type QuestionsTerminalReason =
  | 'confirmed'
  | 'cancelled'
  | 'superseded'
  | 'continuation_missing'

/** One image attached to a question's answer. */
export interface QuestionAnswerAttachment {
  /** Absolute path on the desktop host (rides the prompt attachment pipeline). */
  path: string
  name: string
}

/** The draft answer for one question, as edited in the wizard. */
export interface QuestionDraftAnswer {
  questionId: string
  selectedOptionIds: string[]
  /** Free text: Other input on option questions, the answer on text mode. */
  customText?: string
  /** Explicit "Agent decides" skip. */
  skipped?: boolean
  /** Images attached to this answer (e.g. a screenshot of the issue). */
  attachments?: QuestionAnswerAttachment[]
}

/**
 * One workflow's synchronized state. Keyed by workflowId; a session key can
 * hold several open workflows (legal parallel tool calls) ordered by
 * arrival.
 */
export interface QuestionsWorkflowState {
  /** Stable across requestMore rounds and engine restarts. */
  workflowId: string
  /** The engine gate request currently being answered ('' in awaiting_next/terminal). */
  requestId: string
  /** Engine session key (tab id for desktop-owned sessions). */
  sessionKey: string
  /** Conversation id when known (push metadata, iOS navigation). */
  conversationId?: string
  phase: QuestionsPhase
  terminalReason?: QuestionsTerminalReason
  /** The current page's request as the model sent it. */
  request: QuestionsRequest
  /** Draft answers for the current page, keyed by question order. */
  draft: QuestionDraftAnswer[]
  /** Page-level free-form comment draft. */
  comment?: string
  /** Previously submitted pages (requestMore rounds), oldest first. */
  history: QuestionsPageResult[]
  /** Monotonic compare-and-set token; main increments on every accepted mutation. */
  revision: number
  /** Unix ms the current request arrived. */
  startedAt: number
  /**
   * Submit-outbox marker: the in-flight submission was a requestMore. When
   * engine_client_tool_state proves the request left the engine, the
   * workflow moves to awaiting_next (true) or terminal confirmed (falsy).
   */
  pendingRequestMore?: boolean
}

/** Result of a patch/action attempt (returned to the caller + broadcast). */
export interface QuestionsActionResult {
  actionId: string
  accepted: boolean
  /** Populated on rejection (stale revision, unknown workflow, bad action). */
  error?: string
}

/** The full synchronized Questions state for one fan-out. */
export interface QuestionsStateSnapshot {
  /** Every non-terminal workflow, plus recently-terminal ones for dismissal. */
  workflows: QuestionsWorkflowState[]
  /** The most recent action result, so devices reconcile rejections. */
  lastActionResult?: QuestionsActionResult
}

/** Wizard actions (the enum every transport validates against). */
export type QuestionsActionKind =
  | 'enter_review'
  | 'edit_question'
  | 'request_more'
  | 'final_confirm'
  | 'cancel'

/** A revisioned draft patch from any client. */
export interface QuestionsPatch {
  workflowId: string
  requestId: string
  expectedRevision: number
  /** Unique per attempt; duplicates are acknowledged, not re-applied. */
  actionId: string
  /** Replacement draft entries (by questionId) and/or the page comment. */
  answers?: QuestionDraftAnswer[]
  comment?: string
}

/** A revisioned workflow action from any client. */
export interface QuestionsAction {
  workflowId: string
  requestId: string
  expectedRevision: number
  actionId: string
  kind: QuestionsActionKind
  /** For edit_question: which question re-opens for editing. */
  questionId?: string
  /**
   * Inline final draft for submit-bearing actions (enter_review,
   * request_more, final_confirm): applied atomically with the transition in
   * ONE revision step. Without this the wizard needed a patch followed by
   * an action, and the two could disagree about the revision (the
   * "Review answers did nothing" CAS race).
   */
  answers?: QuestionDraftAnswer[]
  comment?: string
}
