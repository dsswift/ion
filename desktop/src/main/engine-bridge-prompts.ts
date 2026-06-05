import type { ImageAttachmentPayload } from '../shared/types'

/**
 * Sibling helper for EngineBridge.sendPrompt — the prompt-message
 * construction was peeled out so engine-bridge.ts stays under the 600-
 * line TypeScript cap after Fix 7 added the per-prompt bash-allowlist
 * additions field. Pure data shaping with no I/O; the bridge owns the
 * connection and the _send dispatch.
 *
 * Every optional field follows the same wire-protocol pattern: only
 * attach when explicitly present so the engine's omitempty fields
 * round-trip cleanly and the line wire stays minimal for the common
 * case where most overrides are not set.
 */

export interface SendPromptArgs {
  key: string
  text: string
  model?: string
  appendSystemPrompt?: string
  imageAttachments?: ImageAttachmentPayload[]
  implementationPhase?: boolean
  enterPlanModeDescription?: string
  planModeSparseReminder?: string
  planFilePath?: string
  bashAllowlistAdditionsForThisPrompt?: string[]
}

/**
 * Builds the `send_prompt` wire message from the bridge's positional
 * parameters. Each conditional below mirrors the engine's omitempty
 * shape on `ClientCommand` — fields are attached only when explicitly
 * set, so the engine treats absent values as "no override" rather
 * than "explicit zero / empty / false".
 */
export function buildSendPromptMessage(args: SendPromptArgs): Record<string, unknown> {
  const msg: Record<string, unknown> = { cmd: 'send_prompt', key: args.key, text: args.text }
  if (args.model) msg.model = args.model
  if (args.appendSystemPrompt) msg.appendSystemPrompt = args.appendSystemPrompt
  if (args.imageAttachments && args.imageAttachments.length > 0) {
    msg.attachments = args.imageAttachments.map((a) => ({
      media_type: a.mediaType,
      data: a.data,
      path: a.path,
    }))
  }
  // Tells the engine to suppress EnterPlanMode injection for this run.
  // Only sent when truthy so the wire format stays minimal for the
  // common case. The engine's ClientCommand.ImplementationPhase field
  // is omitempty, so this round-trips cleanly. See ADR-003 framing in
  // the plan-mode docs for why structured flags beat prompt prose.
  if (args.implementationPhase) msg.implementationPhase = true
  // Harness-supplied EnterPlanMode tool description (ADR-004). The
  // engine's RunOptions.EnterPlanModeDescription field is omitempty —
  // only send when non-empty so the wire format stays minimal. The
  // engine forwards the string verbatim to the model as the tool
  // description; empty / missing falls back to the engine's one-line
  // neutral default (which the desktop deliberately avoids by always
  // sending its full prose on auto-mode prompts).
  if (args.enterPlanModeDescription) msg.enterPlanModeDescription = args.enterPlanModeDescription
  // Harness-supplied sparse plan-mode reminder text. Only sent when
  // non-empty so the wire format stays minimal for the common case.
  // Mirrors enterPlanModeDescription: the engine uses this verbatim
  // instead of buildPlanModeSparseReminder when present.
  if (args.planModeSparseReminder) msg.planModeSparseReminder = args.planModeSparseReminder
  if (args.planFilePath) msg.planFilePath = args.planFilePath
  // Per-prompt bash-allowlist additions. The engine unions these with
  // the session-scoped allowlist for this run only (no session-state
  // mutation), so a slash command with frontmatter-declared bash
  // permissions can grant them transiently without leaking into the
  // next prompt. See docs/protocol/client-commands.md § set_plan_mode
  // for the three-layer configuration model. Only sent when the array
  // is present and non-empty to keep the wire format minimal.
  if (args.bashAllowlistAdditionsForThisPrompt && args.bashAllowlistAdditionsForThisPrompt.length > 0) {
    msg.bashAllowlistAdditionsForThisPrompt = args.bashAllowlistAdditionsForThisPrompt
  }
  return msg
}

/**
 * Builds the log line for a send_prompt invocation, capturing every
 * carrier field's presence/length so an operator reading
 * `~/.ion/desktop.log` can confirm what the wire payload actually
 * carried without snooping the socket. JSON.stringify is used for the
 * bash-additions array so the empty-vs-undefined distinction stays
 * visible — length collapses both to 0 and hides the user-intent case
 * behind the no-additions case.
 */
export function buildSendPromptLogLine(args: SendPromptArgs): string {
  const attCount = args.imageAttachments?.length ?? 0
  const descLen = args.enterPlanModeDescription?.length ?? 0
  const reminderLen = args.planModeSparseReminder?.length ?? 0
  const bashAddCount = args.bashAllowlistAdditionsForThisPrompt?.length ?? 0
  return `sendPrompt: key=${args.key} len=${args.text.length} model=${args.model ?? 'default'} hasSysPrompt=${!!args.appendSystemPrompt} images=${attCount} implementationPhase=${args.implementationPhase ?? false} enterPlanModeDescLen=${descLen} planModeSparseReminderLen=${reminderLen} planFilePath=${args.planFilePath ?? 'none'} bashAdditions=${bashAddCount}`
}
