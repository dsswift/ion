import { usePreferencesStore } from '../../preferences'
import { parseSlash } from '../../../main/slash-parse'
import { rDebug, rWarn } from '../../rendererLogger'

/**
 * The two placeholder titles a tab can carry before anything has named it.
 *
 * `'New Tab'` comes from `makeLocalTab()`; `'Resumed Session'` from a restored
 * conversation whose label was never set. Both mean "this tab has no real name
 * yet", and three call sites used to open-code the pair — the two `needsTitle`
 * computations in send-slice and the worktree seed. One predicate keeps them
 * from drifting apart.
 */
export function isPlaceholderTitle(title: string): boolean {
  return title === 'New Tab' || title === 'Resumed Session'
}

/**
 * Send-time titling — ONE generated name, applied to the conversation and, when
 * the conversation lives in a worktree that has none, to the worktree too.
 *
 * Fired immediately when the user submits a prompt, in parallel with the
 * engine run. The title is derived entirely from the user's first message,
 * so there is no reason to wait for task_complete — long-running plan-mode
 * sessions would otherwise show no title for their full duration.
 *
 * ── Why the worktree is seeded from here ────────────────────────────────────
 * A worktree's every identifier is a machine string (`ion-03e81090`,
 * `wt/ion-03e81090`, a sha), so it needs a human name — and the prompt that
 * describes the work is the same signal the tab title already comes from.
 * Naming the worktree used to mean a SECOND `generateTitle` round-trip on the
 * same text, which produced a second, independently-worded string: two names
 * for one piece of work, guaranteed to drift. So the worktree is SEEDED with
 * the title generated here rather than generating its own. One LLM call, one
 * string, both surfaces, same moment.
 *
 * Title policy:
 *   - If the `aiGeneratedTitles` preference is off, do nothing — the
 *     send-time truncated title (set by send-slice) stands, and the worktree
 *     keeps its slug until the operator names it.
 *   - If the prompt is a slash command, SKIP titling entirely — for BOTH
 *     surfaces. A slash command is an operation, not a description of the
 *     work: the tab title was already set to the literal command at send time
 *     (truncated to the 40-char standard by send-slice), and preserving it
 *     means the user sees exactly which command was invoked rather than an LLM
 *     interpretation of it. A worktree whose first prompt is `/align` simply
 *     stays on its slug until a real prompt arrives. parseSlash is the
 *     canonical slash parser; we trim first because parseSlash requires the
 *     text to start with `/` and does not trim, and "the first part of the
 *     prompt is a slash command" should tolerate stray leading whitespace.
 *   - Otherwise, fire the one titling round-trip, apply the result via
 *     `renameTab` (which persists it as a session label), and seed the
 *     worktree with the same string.
 *
 * Call site guard: send-slice only calls this when `needsTitle && !isBusy`
 * (first send on a fresh tab). Idempotency is guaranteed by `needsTitle`
 * being false on any subsequent send (tab.title is set to the truncated
 * prompt text by the same set() call that precedes this helper).
 *
 * ── Why the seed is safe under that guard ───────────────────────────────────
 * "First PROMPT wins, not first tab." Several conversations routinely share one
 * worktree, and each of their first sends reaches this helper. The main process
 * refuses a seed for a worktree that already has a title, so whichever
 * conversation prompts first names it and every later one is a logged no-op —
 * the worktree's topic does not change because someone opened a second tab in
 * it to chase a bug. That decision lives against the registry (main-process
 * state) rather than here, because a renderer check would read whichever
 * inventory snapshot this window happens to hold.
 *
 * This is fire-and-forget: neither async call is awaited. On any failure we
 * keep the truncated fallback title already on the tab.
 *
 * Logging policy: every branch logs at DEBUG so the title decision is
 * reconstructable from the renderer log — slash short-circuit, generation, and
 * the seed's outcome (including WHY it was a no-op).
 */
export function maybeSendTimeTitle(
  tabId: string,
  text: string,
  renameTab: (tabId: string, title: string) => void,
  workingDirectory: string,
): void {
  if (!usePreferencesStore.getState().aiGeneratedTitles) {
    return
  }

  const slash = parseSlash(text.trim())
  if (slash) {
    rDebug('event.title', 'slash command, skipping titling for tab and worktree', { tab_id: tabId.slice(0, 8), command: slash.command })
    return
  }

  rDebug('event.title', 'generating AI title at send time', { tab_id: tabId.slice(0, 8) })
  window.ion.generateTitle(text).then((title) => {
    if (!title) {
      // The engine returns "" when no titling model is configured. Nothing to
      // apply and nothing to seed — a legitimate configuration, not an error.
      rDebug('event.title', 'no title generated (no titling model configured?)', { tab_id: tabId.slice(0, 8) })
      return
    }
    renameTab(tabId, title)
    seedWorktreeTitle(workingDirectory, title)
  }).catch((err) => {
    rWarn('event.title', 'AI title generation failed; keeping truncated fallback', {
      tab_id: tabId.slice(0, 8), error: String(err),
    })
  })
}

/**
 * Record a generated title on the worktree the conversation is running in.
 *
 * A pure write, never a generation: the string was produced once by the caller.
 * The main process owns the decision about whether it applies (registered
 * worktree? already named?) and logs every outcome, so this is deliberately
 * thin — it forwards, and reports what came back.
 *
 * `'~'` is home, not a worktree, and is filtered here rather than round-tripping
 * to be refused.
 */
export function seedWorktreeTitle(workingDirectory: string, title: string): void {
  if (!workingDirectory || workingDirectory === '~') {
    return
  }

  window.ion.gitWorktreeSeedTitle(workingDirectory, title).then((result) => {
    // Both branches log: the no-op reason is what makes "why is this row still
    // a slug?" answerable from the renderer log alone.
    if (result.ok) {
      rDebug('event.title', 'worktree seeded from the conversation title', { dir: workingDirectory, title: result.title ?? '' })
    } else {
      rDebug('event.title', 'worktree seed was a no-op', {
        dir: workingDirectory, reason: result.reason ?? 'unknown',
      })
    }
  }).catch((err) => {
    rWarn('event.title', 'worktree seed call failed', { dir: workingDirectory, error: String(err) })
  })
}

/**
 * Carry a conversation's EXISTING name onto a worktree just cut for it.
 *
 * The `abc` case: a conversation the operator named (or that titled itself from
 * an earlier prompt) becomes a worktree, and the worktree arrives with the same
 * name rather than a hex slug the operator then has to reconcile against the tab
 * strip. Nothing is generated here — the name already exists.
 *
 * A tab still on a placeholder has nothing worth carrying, so it seeds nothing
 * and the worktree is named later by the first real prompt sent in it. That is
 * the panel's "New worktree" path, where the tab is born as `New Tab`.
 */
export function seedWorktreeFromTab(
  tab: { title: string; customTitle: string | null },
  worktreePath: string,
): void {
  const name = tab.customTitle || tab.title
  if (!name || isPlaceholderTitle(name)) {
    rDebug('event.title', 'no conversation name to seed the worktree with', {
      worktree_path: worktreePath, title: name,
    })
    return
  }
  seedWorktreeTitle(worktreePath, name)
}

