/**
 * Builtin slash-command dispatcher for the CLI-tab InputBar.
 *
 * Historically this file handled six builtins (/clear, /cost, /model, /mcp,
 * /skills, /help). The other five were audited and removed because each one
 * was strictly worse than the dedicated UI already present:
 *   - /cost     — duplicated by the always-visible status-bar cost/token
 *                 indicator (see ConversationStatusBar / EngineFooter).
 *   - /model    — duplicated (and worse than) StatusBarModelPicker /
 *                 ModelPickerPopover and the AIModelsCategory settings page.
 *   - /mcp      — was the only MCP surface but mostly emitted "No MCP data
 *                 yet"; a proper status-bar indicator is the right fix if
 *                 we ever want this back.
 *   - /skills   — duplicated the slash menu itself, which already lists
 *                 every discovered project/user command under its own
 *                 groups (see SlashCommandMenu.getFilteredCommandsWithExtras).
 *   - /help     — self-referential; the slash menu shows a description
 *                 next to each entry, so the menu *is* the help.
 *
 * Only /clear survives as a renderer-side builtin. Its semantics are
 * **checkpoint**, not "reset to a blank tab":
 *
 *   - The on-screen conversation scrollback is preserved. /clear inserts
 *     a divider system message so the user can scroll back to reference
 *     anything that happened before the checkpoint.
 *   - The LLM's view of history is wiped. The dispatcher forwards to the
 *     engine's `clear` command via window.ion.engineCommand, which nulls
 *     conv.Messages on disk so the next prompt is sent with no prior
 *     turns.
 *   - The harness re-bootstraps. The engine re-fires session_start after
 *     the wipe so any priming the harness would do for a fresh session
 *     happens again. The session, extension subprocesses, and MCP
 *     connections stay alive — only the LLM-visible history changes.
 *
 * If a user wants a truly empty tab they close-and-reopen the tab.
 *
 * The divider format is centralized in `formatClearDivider`; both this
 * dispatcher (for CLI tabs via addSystemMessage) and InputBar.tsx (for
 * engine tabs via addEngineSystemMessage) call it so the wording stays
 * consistent. SystemMessage.tsx detects the leading `── Cleared` sentinel
 * and renders the message as a horizontal rule instead of the default
 * system-message bubble.
 */

import type { TabState } from '../../shared/types'
import { formatClearDivider } from '../../shared/clear-divider'

export { formatClearDivider }

export interface ExecuteCommandDeps {
  tab: TabState | undefined
  clearTab: () => void
  addSystemMessage: (msg: string) => void
}

/**
 * Run a builtin slash command. Currently only `/clear` is recognised.
 * Unknown commands are a no-op (the caller decides whether to fall through
 * to the normal prompt-send path).
 *
 * For /clear we do NOT call `clearTab()` — scrollback is intentionally
 * preserved. We forward to the engine command path (which wipes
 * conv.Messages on disk and re-fires session_start) and insert a divider
 * system message client-side. `clearTab` is left on the deps interface
 * for now, dead at the call site, to avoid widening the diff into the
 * tab-slice; it can be cleaned up in a follow-up.
 */
export function executeBuiltinCommand(commandName: string, deps: ExecuteCommandDeps): void {
  const { tab, addSystemMessage } = deps

  switch (commandName) {
    case '/clear':
      if (tab) {
        window.ion.engineCommand(tab.id, 'clear', '')
      }
      addSystemMessage(formatClearDivider(new Date()))
      return
  }
}
