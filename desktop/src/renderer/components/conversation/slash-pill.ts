/**
 * Pure slash-command PILL resolution for user message bubbles.
 *
 * Extracted from UserMessage.tsx so the pill decision is unit-testable
 * without pulling React / react-markdown / framer-motion into a node-env
 * test. UserMessage.tsx and QueuedMessage import from here.
 *
 * The pill is INDEPENDENT of `enableClaudeCompat` — slash commands are an
 * engine-owned concept, so gating the pill on Claude-compat was the wrong
 * gate. None of these functions read preferences or store state.
 */

import type { Message } from '../../../shared/types'

/**
 * Parse a leading slash command from message content (the FALLBACK source).
 * Returns `{ command, args }` when content starts with `/cmd [args]`, or
 * `null` when no slash command is detected.
 *
 * The regex requires the command to start with a letter so that paths like
 * `/usr/bin/foo` (which contain multiple slashes) don't match.
 */
export function parseSlashCommand(content: string): { command: string; args: string } | null {
  const match = content.match(/^\/([a-zA-Z][a-zA-Z0-9_:-]*)\s*([\s\S]*)$/)
  if (!match) return null
  return { command: `/${match[1]}`, args: match[2] }
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
 *      starts with `/` but carry no metadata yet (extension commands,
 *      optimistic send-slice bubbles before any engine round-trip).
 *
 * Returns `{ command, args } | null` (null = render as plain text).
 */
export function resolveSlashPill(
  message: Pick<Message, 'slashCommand' | 'slashArgs'>,
  displayContent: string,
): { command: string; args: string } | null {
  if (message.slashCommand) {
    return {
      command: message.slashCommand,
      args: message.slashArgs ?? stripSlashLabel(displayContent, message.slashCommand),
    }
  }
  return parseSlashCommand(displayContent)
}
