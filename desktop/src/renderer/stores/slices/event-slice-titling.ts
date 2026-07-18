import { usePreferencesStore } from '../../preferences'
import { parseSlash } from '../../../main/slash-parse'
import { rDebug } from '../../rendererLogger'

/**
 * Tab-title generation at send time.
 *
 * Fired immediately when the user submits a prompt, in parallel with the
 * engine run. The title is derived entirely from the user's first message,
 * so there is no reason to wait for task_complete — long-running plan-mode
 * sessions would otherwise show no title for their full duration.
 *
 * Title policy:
 *   - If the `aiGeneratedTitles` preference is off, do nothing — the
 *     send-time truncated title (set by send-slice) stands.
 *   - If the prompt is a slash command, SKIP LLM titling entirely. The tab
 *     title was already set to the literal slash command at send time
 *     (truncated to the 40-char standard by send-slice). Preserving it means
 *     the user sees exactly which command was invoked rather than an LLM
 *     interpretation of it. parseSlash is the canonical slash parser; we trim
 *     first because parseSlash requires the text to start with `/` and does
 *     not trim, and "the first part of the prompt is a slash command" should
 *     tolerate stray leading whitespace.
 *   - Otherwise, fire the LLM titling round-trip and apply the result via
 *     `renameTab` (which persists it as a session label).
 *
 * Call site guard: send-slice only calls this when `needsTitle && !isBusy`
 * (first send on a fresh tab). Idempotency is guaranteed by `needsTitle`
 * being false on any subsequent send (tab.title is set to the truncated
 * prompt text by the same set() call that precedes this helper).
 *
 * This is fire-and-forget: the async generateTitle promise is intentionally
 * not awaited. On any failure we keep the truncated fallback title already
 * on the tab.
 *
 * Logging policy: both branches log at DEBUG so the title decision is
 * reconstructable from the renderer log — slash short-circuit vs. LLM
 * generation.
 */
export function maybeSendTimeTitle(
  tabId: string,
  text: string,
  renameTab: (tabId: string, title: string) => void,
): void {
  if (!usePreferencesStore.getState().aiGeneratedTitles) {
    return
  }

  const slash = parseSlash(text.trim())
  if (slash) {
    rDebug('event.title', 'slash command tab, skipping LLM titling', { tab_id: tabId.slice(0, 8), command: slash.command })
    return
  }

  rDebug('event.title', 'generating AI title at send time', { tab_id: tabId.slice(0, 8) })
  window.ion.generateTitle(text).then((title) => {
    if (title) {
      renameTab(tabId, title)
    }
  }).catch(() => { /* keep truncated fallback */ })
}
