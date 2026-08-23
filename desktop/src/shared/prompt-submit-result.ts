/**
 * prompt-submit-result — what the send path reports back to its caller.
 *
 * ── Why submit() must report, not just log ──────────────────────────────────
 *
 * `InputBarSend.dispatchSend` enforces "decide, then clear, then submit": the
 * operator's text is destroyed only after acceptance. That contract holds
 * inside ONE window. It is defeated across the Studio mirror boundary.
 *
 * `submit` is a FORWARDED action (shared/studio-mirror-actions.ts). When the
 * Studio presentation is active, the InputBar runs in the MIRROR window, so
 * `dispatchSend` decides against MIRROR state — then clears the input and the
 * persisted draft, then forwards the call over IPC to the OWNER, which runs
 * the authoritative guard against OWNER state and can refuse. The decision and
 * the enforcement read two different stores.
 *
 * That is not hypothetical. A conversation whose completion the owner had never
 * applied sat at 'connecting' in the owner while the mirror showed 'completed'.
 * The mirror's gate passed, the text was cleared, the owner refused with
 * `reason=connecting`, and the operator's instruction was destroyed — visible
 * afterwards only as one WARN line next to a `studio_ipc: calling action on
 * owner` line for the same instant.
 *
 * So the refusal has to travel back. The mirror's forwarding wrapper already
 * round-trips the action and returns `reply.value`, so a returned result
 * crosses the boundary for free; a logged-and-dropped refusal cannot.
 */

import type { PromptRefusalReason } from './prompt-acceptance'

/**
 * Outcome of a submit attempt. Additive: callers that ignore the return value
 * keep their existing behaviour, and the value is structured-clone safe so it
 * survives the mirror's IPC round trip.
 */
export type PromptSubmitResult =
  | { accepted: true }
  | {
      accepted: false
      reason: PromptRefusalReason | 'no-tab'
      /** Operator-facing sentence. Shown in the conversation, not just logged. */
      message: string
    }

export const PROMPT_ACCEPTED: PromptSubmitResult = { accepted: true }

/**
 * Operator-facing copy for a refusal.
 *
 * The refusal's own `detail` is written for a log line ("session is still
 * connecting"). This is what a person reads in their conversation, so it names
 * the state AND says the text was kept — a message that only reports the
 * failure would leave the operator guessing whether they must retype.
 */
export function promptRefusalMessage(reason: PromptRefusalReason | 'no-tab'): string {
  switch (reason) {
    case 'connecting':
      return 'Not sent: the conversation is still connecting. Your text was kept — send it again in a moment.'
    case 'input-locked':
      return 'Not sent: this conversation is locked and accepts no new input. Your text was kept.'
    case 'tabs-not-ready':
      return 'Not sent: conversations are still being restored. Your text was kept — send it again in a moment.'
    case 'no-tab':
      return 'Not sent: no active conversation. Your text was kept.'
  }
}

/** Build a refusal result with its operator-facing message. */
export function promptRefused(reason: PromptRefusalReason | 'no-tab'): PromptSubmitResult {
  return { accepted: false, reason, message: promptRefusalMessage(reason) }
}
