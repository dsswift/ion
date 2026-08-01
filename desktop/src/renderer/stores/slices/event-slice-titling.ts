import { usePreferencesStore } from '../../preferences'
import { parseSlash } from '../../../main/slash-parse'
import { rDebug, rWarn } from '../../rendererLogger'

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

/**
 * Worktree-title generation at send time.
 *
 * ── Why a worktree needs its own title ──────────────────────────────────────
 * Every identifier a worktree has is a machine string: the directory
 * (`ion-03e81090`), the branch (`wt/ion-03e81090`), a commit sha. A panel full
 * of those tells the operator nothing about which work is which. The first
 * prompt sent inside a worktree describes the work exactly, and it is the same
 * signal the tab title is already derived from — so the worktree is named from
 * it too, through the same engine round-trip.
 *
 * ── Why this is NOT under the tab's `needsTitle` guard ──────────────────────
 * `needsTitle` means "this TAB has no title yet". A conversation re-opened into
 * an existing worktree has a tab title already while the worktree may still
 * have none, so gating on it would leave old worktrees permanently unnamed —
 * the exact case the lazy backfill exists to cover. Idempotency comes from the
 * main process instead, which checks the registry and no-ops when the worktree
 * is already named. That check is also why calling this on EVERY send is cheap:
 * a worktree costs at most one titling round-trip, ever.
 *
 * Slash commands are skipped for the same reason tab titling skips them: the
 * text is a command invocation, not a description of the work.
 *
 * Fire-and-forget. A failure leaves the row showing its slug, and the next
 * prompt tries again; the main process logs every outcome.
 */
export function maybeTitleWorktree(workingDirectory: string, text: string): void {
  if (!usePreferencesStore.getState().aiGeneratedTitles) {
    return
  }
  if (!workingDirectory || workingDirectory === '~') {
    return
  }

  const slash = parseSlash(text.trim())
  if (slash) {
    rDebug('event.title', 'slash command, skipping worktree titling', { command: slash.command })
    return
  }

  window.ion.gitWorktreeAutotitle(workingDirectory, text).then((result) => {
    // Both branches log: the no-op reason is what makes "why is this row still
    // a slug?" answerable from the renderer log alone.
    if (result.ok) {
      rDebug('event.title', 'worktree titled', { dir: workingDirectory, title: result.title ?? '' })
    } else {
      rDebug('event.title', 'worktree titling was a no-op', {
        dir: workingDirectory, reason: result.reason ?? 'unknown',
      })
    }
  }).catch((err) => {
    rWarn('event.title', 'worktree titling call failed', { dir: workingDirectory, error: String(err) })
  })
}
