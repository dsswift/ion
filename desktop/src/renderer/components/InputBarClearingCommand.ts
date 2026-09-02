import type { DiscoveredCommand } from "../../shared/types";

/**
 * Pre-send gate for a slash command that clears the conversation.
 *
 * A command declaring `clears-conversation` frontmatter wipes the
 * conversation's model-visible history before its body runs. That is the point
 * of the flag — a review must judge work against a durable spec rather than
 * against the discussion that produced it, and a squash must read the
 * repository rather than a transcript. But it is also destructive from the
 * operator's seat: they typed a command and their conversation disappears.
 *
 * The engine performs the clear unconditionally and never asks, because the
 * engine does not block for user input. So the confirmation belongs here, on
 * the client, before the prompt is ever sent. This module is the decision half
 * of that gate, kept separate from InputBar so it is unit-testable without
 * rendering the component.
 */

/** What the operator is about to lose, or null when nothing is at stake. */
export interface ClearingCommandPrompt {
  /** Bare command name without the leading slash. */
  command: string;
  /** Full text to re-submit once the operator confirms. */
  pendingInput: string;
}

/** The store facts this decision needs. Kept minimal so tests need no store. */
export interface ClearingCommandContext {
  /**
   * Whether the conversation currently holds anything a clear would discard.
   *
   * This mirrors the engine's own freshness rule: a conversation with no
   * model-visible history is already at a fresh boundary, so clearing it
   * changes nothing and the operator must not be interrupted. That covers both
   * a brand-new conversation and one the operator just cleared.
   */
  hasHistory: boolean;
  /** Commands discovered for this working directory, carrying the flag. */
  commands: readonly DiscoveredCommand[];
}

/**
 * Extract the bare command name from raw input, or null when the text is not a
 * lone slash invocation.
 *
 * Only a command at the very start of the input counts. A "/" inside prose, a
 * file path, or a longer message is not an invocation, and treating it as one
 * would pop a destructive-action dialog over ordinary typing.
 */
export function parseCommandName(input: string): string | null {
  const match = /^\/([a-zA-Z][a-zA-Z0-9_:-]*)(?:\s|$)/.exec(input.trim());
  return match ? match[1] : null;
}

/**
 * Decide whether this submission needs a clear-confirmation.
 *
 * Returns null to let the send proceed untouched — the common case, and
 * deliberately the default for every uncertainty:
 *
 *   - not a slash invocation
 *   - a command the discovery feed does not know (an extension command, or a
 *     feed that has not loaded yet)
 *   - a command that does not declare the flag
 *   - a conversation with no history to lose
 *
 * Failing open matters here. A missed confirmation costs the operator a clear
 * they arguably asked for by typing the command; a spurious dialog on every
 * ordinary message would train them to dismiss it without reading, which
 * destroys the warning's value for the case that counts.
 */
export function resolveClearingCommand(
  input: string,
  ctx: ClearingCommandContext,
): ClearingCommandPrompt | null {
  if (!ctx.hasHistory) return null;

  const name = parseCommandName(input);
  if (!name) return null;

  const match = ctx.commands.find((c) => c.name === name);
  if (!match?.clearsConversation) return null;

  return { command: name, pendingInput: input };
}

/** Operator-facing dialog copy for a pending clearing command. */
export function clearingCommandMessage(command: string): string {
  return `/${command} starts a fresh context boundary. It clears this conversation's history first, then runs with no prior context.\n\nThe transcript stays readable, but the models will not see it again.`;
}
