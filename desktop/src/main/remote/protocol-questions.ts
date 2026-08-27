/**
 * Guided Questions wire members — desktop↔iOS protocol for the
 * AskUserQuestions wizard. Extracted from protocol.ts for the line cap.
 *
 * desktop_questions_state is CRITICAL transport state. Valid requests have no
 * receiver-side content or count limit, so a large complete replacement may be
 * split into ordered desktop_payload_chunk transport envelopes. iOS verifies
 * and reassembles every byte before it publishes the replacement. A full
 * desktop_snapshot carries the same Questions state and uses the same path,
 * so first paint and recovery preserve identical content and order.
 *
 * Lockstep contract (ADR 008): every member here ships to iOS
 * (RemoteCommand.swift / NormalizedEvent.swift TypeKeys) in the same PR.
 */
import type {
  QuestionsAction,
  QuestionsPatch,
  QuestionsStateSnapshot,
} from '../../shared/questions-state'

/** Ion → iOS: the authoritative Questions state (complete replacement). */
export type RemoteQuestionsEvent = {
  type: 'desktop_questions_state'
  /** The owning conversation tab. */
  tabId: string
  state: QuestionsStateSnapshot
}

/** iOS → Ion: wizard mutations and targeted refresh. */
export type RemoteQuestionsCommand =
  | { type: 'desktop_questions_patch'; tabId: string; patch: QuestionsPatch }
  | { type: 'desktop_questions_action'; tabId: string; action: QuestionsAction }
  /** Targeted re-send of the authoritative state to the requesting device. */
  | { type: 'desktop_questions_refresh'; tabId: string }
