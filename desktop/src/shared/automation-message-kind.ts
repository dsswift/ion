import { suppressesInjection } from "./injection-policy";

/**
 * How a submitted conversation Message was authored, for Desktop Automation.
 *
 * This is the authorship distinction the `conversation:message-submitted` event
 * carries so a rule can fire only for real operator prompts and never for a
 * slash command, a Guided Questions answer, or a machine-authored injection.
 */
export type AutomationMessageKind = "prompt" | "slash" | "structured" | "machine";

/**
 * Classify a submitted Message from facts known at the client boundary.
 *
 * Precedence is deliberate: a machine-authored turn is machine regardless of its
 * text; a user-authored structured submission (Guided Questions) is structured
 * even though a person produced it; a slash invocation is slash; everything else
 * is an ordinary prompt. Authorship is never inferred from the message text —
 * only from the source marker and the engine injection kind.
 */
export function classifyAutomationMessageKind(input: {
  source?: string;
  injectionKind?: string;
  isSlash: boolean;
}): AutomationMessageKind {
  if (input.source === "machine" || suppressesInjection({ injectionKind: input.injectionKind }))
    return "machine";
  if (input.injectionKind === "structured_answer") return "structured";
  if (input.isSlash) return "slash";
  return "prompt";
}
