/**
 * Pure slash-command PILL resolution for user message bubbles.
 *
 * Extracted so the pill decision is unit-testable without pulling React /
 * react-markdown / framer-motion into a node-env test. `MessageBubble` (user
 * bubbles) and `QueuedMessage` import from here.
 *
 * The pill is INDEPENDENT of `enableClaudeCompat` — slash commands are an
 * engine-owned concept, so gating the pill on Claude-compat was the wrong
 * gate. None of these functions read preferences or store state; a caller
 * that wants engine model names passes its Environment's model list in.
 */

import { getModelDisplayLabel } from '@ion/shared/types-models'
import type { ModelEntry } from '@ion/shared/types-models'
import type { Message } from '@ion/shared/types'
import { parseSlash } from '../slash-parse'

/**
 * Parse a leading slash command from message content (the FALLBACK source).
 * Returns `{ command, args }` when content starts with `/cmd [args]`, or
 * `null` when no slash command is detected.
 *
 * Canonical parser accepts identifier-shaped names and rejects paths like
 * `/usr/bin/foo`, which contain multiple slashes.
 */
export function parseSlashCommand(content: string): { command: string; args: string } | null {
  const parsed = parseSlash(content)
  if (!parsed) return null
  return { command: `/${parsed.command}`, args: parsed.args }
}

/**
 * Derive the pill BODY (args) for a metadata-driven pill. The engine stored
 * the RAW invocation as `content`, so when content starts with the label
 * (`/command`) we strip the label + one separator and keep the remainder.
 * Falls back to the whole content when it doesn't start with the label
 * (defensive — should not happen for a well-formed slash turn).
 */
export function stripSlashLabel(content: string, label: string): string {
  if (content.startsWith(label)) {
    return content.slice(label.length).replace(/^\s+/, '')
  }
  return content
}

/**
 * Decide whether a user message renders as a command PILL, and what the pill
 * label + body are. Pure (no store/preferences access).
 *
 * Resolution order:
 *   1. Engine metadata (`message.slashCommand`): the engine resolved this
 *      displayed turn as a slash invocation. `content` holds the RAW
 *      `/command args`; the body is `slashArgs` when present, else the raw
 *      content with the label stripped.
 *   2. Fallback content parse: messages whose `content` still literally
 *      starts with `/` but carry no command metadata yet (extension commands,
 *      optimistic send-slice bubbles before any engine round-trip). Model
 *      provenance may arrive first on `user_turn_persisted`; preserve it so
 *      live optimistic rows render the same model pill as restored history.
 *
 * `models` is the conversation's Environment model list, used only to name the
 * command's model. Omit it when the model name is not rendered.
 *
 * Returns `{ command, args, modelDisplay } | null` (null = render as plain text).
 */
export function resolveSlashPill(
  message: Pick<Message, 'slashCommand' | 'slashArgs' | 'slashModelAlias' | 'slashModelEffective'>,
  displayContent: string,
  models: readonly ModelEntry[] = [],
): { command: string; args: string; modelDisplay: string | null } | null {
  if (message.slashCommand) {
    return {
      command: message.slashCommand,
      args: message.slashArgs ?? stripSlashLabel(displayContent, message.slashCommand),
      modelDisplay: formatSlashModelDisplay(message.slashModelAlias, message.slashModelEffective, models),
    }
  }
  const parsed = parseSlashCommand(displayContent)
  if (!parsed) return null
  return {
    ...parsed,
    modelDisplay: formatSlashModelDisplay(message.slashModelAlias, message.slashModelEffective, models),
  }
}

/**
 * Format command-owned model provenance. The engine emits a tier selector with
 * the concrete model it resolved for that command, so a valid tier renders as
 * `Fast · Claude Sonnet 5`. A direct model selector repeats its effective model
 * and therefore renders once. Both fields are engine facts, never desktop
 * picker state.
 *
 * The model is named exactly as the model picker names it: the engine's
 * displayName for the matching entry in `models`. A model with no live entry,
 * or an entry the engine did not name, is shown by its bare id.
 */
export function formatSlashModelDisplay(tier?: string, model?: string, models: readonly ModelEntry[] = []): string | null {
  const tierLabel = tier ? tier[0].toUpperCase() + tier.slice(1) : ''
  const bareModel = model?.split('/').pop() || ''
  const entry = model ? models.find((m) => m.id === model) : undefined
  const modelLabel = entry ? getModelDisplayLabel(entry) : bareModel
  // A model without a selector can be shown safely. A selector without its
  // resolved model is not enough evidence for a tier badge.
  if (!modelLabel) return null
  if (!tierLabel) return modelLabel
  // A direct model in command frontmatter is both selector and effective model.
  // Do not repeat it as `model · model`.
  if (tier && tier.toLowerCase() === bareModel.toLowerCase()) return modelLabel
  return `${tierLabel} · ${modelLabel}`
}
