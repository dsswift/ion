/**
 * Slash-command parsing — single shared regex.
 *
 * Originally this file owned the entire remote slash-routing decision tree
 * (interceptCliSlash, interceptEngineSlash, divider injection). After the
 * unified prompt pipeline (prompt-pipeline.ts) absorbed routing, the file
 * was reduced to a single parser export so existing imports (notably the
 * test in `__tests__/slash-intercept.test.ts`) still resolve while we
 * deprecate the path.
 *
 * NEW CODE SHOULD IMPORT FROM `prompt-pipeline.ts` OR `slash-parse.ts`.
 * This file is retained for backward compatibility only and may be removed
 * once the test file is rewritten.
 */

import { parseSlash } from '../../slash-parse'

/**
 * Parse a leading slash command out of free-form prompt text. Returns null
 * when the text is not a slash command or the command name is not a valid
 * identifier shape.
 *
 * Thin wrapper over `parseSlash` from `slash-parse.ts` — the canonical
 * parser. The wrapper preserves the legacy contract that returns a flat
 * object (or null) and accepts whitespace-prefixed text by trimming first.
 */
export function parseSlashCommand(text: string): { command: string; args: string } | null {
  const result = parseSlash(text.trim())
  if (!result) return null
  return { command: result.command, args: result.args }
}
