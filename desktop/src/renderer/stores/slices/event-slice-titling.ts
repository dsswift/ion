import type { Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import { parseSlash } from '../../../main/slash-parse'

/**
 * Tab-title resolution on task_complete.
 *
 * Extracted from event-slice.ts (the task_complete case) to keep that file
 * under the 600-line cap. The logic is a cohesive unit: decide whether a tab
 * earns an LLM-generated title and, if so, kick off the async generation.
 *
 * Title policy:
 *   - If the tab already has a user-set `customTitle`, or the
 *     `aiGeneratedTitles` preference is off, do nothing — the send-time
 *     truncated title (set by send-slice) stands.
 *   - If the first user prompt is a slash command, SKIP LLM titling entirely.
 *     The tab title was already set to the literal slash command at send time
 *     (truncated to the 40-char standard by send-slice). Preserving it means
 *     the user sees exactly which command was invoked rather than an LLM
 *     interpretation of it. parseSlash is the canonical slash parser; we trim
 *     first because parseSlash requires the text to start with `/` and does
 *     not trim, and "the first part of the prompt is a slash command" should
 *     tolerate stray leading whitespace.
 *   - Otherwise, fire the LLM titling round-trip and apply the result via
 *     `renameTab` (which persists it as a session label, exactly as before).
 *
 * This is fire-and-forget: the async generateTitle promise is intentionally
 * not awaited (the reducer is synchronous). On any failure we keep the
 * truncated fallback title already on the tab.
 *
 * Logging policy: both branches log at INFO so the title decision is
 * reconstructable from the renderer console — slash short-circuit (with the
 * preserved literal title) vs. LLM generation.
 */
export function maybeGenerateTabTitle(
  tabId: string,
  customTitle: string | null,
  currentTitle: string,
  messages: Message[],
  renameTab: (tabId: string, title: string) => void,
): void {
  if (customTitle || !usePreferencesStore.getState().aiGeneratedTitles) {
    return
  }
  const firstUserMsg = messages.find((m) => m.role === 'user')
  if (!firstUserMsg) return

  const slash = parseSlash(firstUserMsg.content.trim())
  if (slash) {
    console.log(`[task_complete] tab=${tabId.slice(0, 8)} branch=slashTitle command=/${slash.command} skipping LLM titling; preserving literal title=${JSON.stringify(currentTitle)}`)
    return
  }

  console.log(`[task_complete] tab=${tabId.slice(0, 8)} branch=llmTitle generating AI title from firstUserMsg`)
  window.ion.generateTitle(firstUserMsg.content).then((title) => {
    if (title) {
      renameTab(tabId, title)
    }
  }).catch(() => { /* keep truncated fallback */ })
}
