/**
 * Guided Questions wire members — desktop↔iOS protocol for the
 * AskUserQuestions wizard. Extracted from protocol.ts for the line cap.
 *
 * desktop_questions_state is CRITICAL transport state: the schema limits in
 * shared/questions-schema.ts bound the canonical state under the transport
 * caps (pinned by the structural transport test), so it ships without a lossy
 * degrader. A full desktop_snapshot also carries the current Questions state
 * per matching RemoteTabState, so iOS first paint and seq-gap recovery never
 * depend on catching a delta.
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
