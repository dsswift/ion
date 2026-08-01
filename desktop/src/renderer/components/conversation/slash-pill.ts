/**
 * Pure slash-command PILL resolution for user message bubbles.
 *
 * Extracted so the pill decision is unit-testable without pulling React /
 * react-markdown / framer-motion into a node-env test. `MessageBubble` (user
 * bubbles) and `QueuedMessage` import from here.
 *
 * The pill is INDEPENDENT of `enableClaudeCompat` — slash commands are an
 * engine-owned concept, so gating the pill on Claude-compat was the wrong
 * gate. None of these functions read preferences or store state.
 */

import { getModelDisplayLabel } from '../../stores/model-labels'
import type { Message } from '../../../shared/types'
import { parseSlash } from '../../../main/slash-parse'

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
 * Returns `{ command, args, modelDisplay } | null` (null = render as plain text).
 */
export function resolveSlashPill(
  message: Pick<Message, 'slashCommand' | 'slashArgs' | 'slashModelAlias' | 'slashModelEffective'>,
  displayContent: string,
): { command: string; args: string; modelDisplay: string | null } | null {
  if (message.slashCommand) {
    return {
      command: message.slashCommand,
      args: message.slashArgs ?? stripSlashLabel(displayContent, message.slashCommand),
      modelDisplay: formatSlashModelDisplay(message.slashModelAlias, message.slashModelEffective),
    }
  }
  const parsed = parseSlashCommand(displayContent)
  if (!parsed) return null
  return {
    ...parsed,
    modelDisplay: formatSlashModelDisplay(message.slashModelAlias, message.slashModelEffective),
  }
}

/**
 * Format the per-run model provenance badge text from the engine-resolved
 * tier and model name. Returns e.g. "Standard · GPT-5.6 Terra" when
 * both are present, just the tier or model alone when only one is set,
 * or null when neither is available.
 */
export function formatSlashModelDisplay(tier?: string, model?: string): string | null {
  const tierLabel = tier ? tier[0].toUpperCase() + tier.slice(1) : ''
  const bareModel = model?.split('/').pop() || ''
  const gptVariant = bareModel.match(/^gpt-(\d+)[.-](\d+)-([a-z][a-z0-9-]*)$/i)
  const modelLabel = gptVariant
    ? `GPT ${gptVariant[1]}.${gptVariant[2]} ${gptVariant[3][0].toUpperCase()}${gptVariant[3].slice(1)}`
    : bareModel ? getModelDisplayLabel(bareModel) : ''
  if (!tierLabel && !modelLabel) return null
  if (tierLabel && modelLabel) return `${tierLabel} · ${modelLabel}`
  return tierLabel || modelLabel || null
}
