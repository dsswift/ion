/**
 * Which model a client names for a conversation.
 *
 * The conversation's server decides the model (`resolvedModel`). A client
 * never falls back to a default model of its own: that default belongs to
 * the client's local server and says nothing about a conversation elsewhere.
 * The instance's own `modelOverride` is read first only because a pick the
 * operator just made reaches the screen before the server's next publish.
 */
interface ModelFields {
  modelOverride?: string | null
  sessionModel?: string | null
  resolvedModel?: string
}

/** The model the conversation is set to: what the picker shows as selected. */
export function selectedConversationModel(inst: ModelFields | null | undefined): string {
  return inst?.modelOverride || inst?.resolvedModel || ''
}

/**
 * The model the conversation is actually on, for sizing and capabilities (the
 * context window, the thinking levels). What the engine last reported wins
 * over a default, because a default may never have been applied.
 */
export function runningConversationModel(inst: ModelFields | null | undefined): string {
  return inst?.modelOverride || inst?.sessionModel || inst?.resolvedModel || ''
}
