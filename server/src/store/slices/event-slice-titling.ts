import { conversationPreferencesFor } from '../conversation-preferences-read'
import { parseSlash } from '../../slash-parse'
import { rDebug, rWarn } from '../rendererLogger'
import { generateTitle, gitWorktreeSeedTitle } from '../host-api'

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
 * Send-time titling — the conversation's name, applied to the conversation and,
 * when the conversation lives in a worktree that has none, to the worktree too.
 *
 * Fired immediately when the user submits a prompt, in parallel with the
 * engine run. The title is derived entirely from the user's first message,
 * so there is no reason to wait for task_complete — long-running plan-mode
 * sessions would otherwise show no title for their full duration.
 *
 * ── Why the worktree is seeded from here ────────────────────────────────────
 * A worktree's every identifier is a machine string (`ion-03e81090`,
 * `wt/ion-03e81090`, a sha), so it needs a human name — and the prompt that
 * describes the work is the same signal the tab title already comes from. The
 * worktree never generates a name of its own: it takes the conversation's, so
 * the two cannot drift.
 *
 * A conversation is named in two steps, and the worktree follows both:
 *   1. `fallbackTitle` — the truncated prompt the tab already shows. It is
 *      stamped on the worktree right away, so the worktree is named even when
 *      no generated title ever arrives (preference off, no titling model, a
 *      failed titling call).
 *   2. The generated title, when one arrives. It renames the tab and replaces
 *      the worktree's stamp — but only while the worktree still carries this
 *      conversation's own fallback (see `seedWorktreeTitle`).
 *
 * Title policy:
 *   - If the prompt is a slash command, SKIP titling entirely — for BOTH
 *     surfaces. A slash command is an operation, not a description of the
 *     work: the tab title was already set to the literal command at send time,
 *     and preserving it means the user sees exactly which command was invoked
 *     rather than an LLM interpretation of it. A worktree whose first prompt is
 *     `/align` is not named by it. parseSlash is the canonical slash parser; we
 *     trim first because parseSlash requires the text to start with `/` and
 *     does not trim, and "the first part of the prompt is a slash command"
 *     should tolerate stray leading whitespace.
 *   - If the `aiGeneratedTitles` preference is off, stop after step 1 — the
 *     truncated title stands on both surfaces.
 *   - Otherwise, fire the one titling round-trip and apply the result via
 *     `renameTab` (which persists it as a session label) and to the worktree.
 *
 * Call site guard: send-slice only calls this on the first send of a tab that
 * has no real name yet, so a later prompt never re-titles either surface.
 *
 * ── "First PROMPT wins, not first tab." ─────────────────────────────────────
 * Several conversations routinely share one worktree, and each of their first
 * sends reaches this helper. A seed is refused for a worktree that already has
 * a title, so whichever conversation prompts first names it and every later one
 * is a logged no-op — the worktree's topic does not change because someone
 * opened a second tab in it to chase a bug. The same refusal protects a name
 * the operator typed.
 *
 * This is fire-and-forget: no async call is awaited. On any failure we keep
 * the truncated fallback title already on the tab and the worktree.
 *
 * Logging policy: every branch logs at DEBUG so the title decision is
 * reconstructable from the log — slash short-circuit, generation, and each
 * seed's outcome (including WHY it was a no-op).
 */
export function maybeSendTimeTitle(
  tabId: string,
  text: string,
  fallbackTitle: string,
  renameTab: (tabId: string, title: string) => void,
  workingDirectory: string,
): void {
  const slash = parseSlash(text.trim())
  if (slash) {
    rDebug('event.title', 'slash command, skipping titling for tab and worktree', { tab_id: tabId.slice(0, 8), command: slash.command })
    return
  }

  seedWorktreeTitle(workingDirectory, fallbackTitle)

  // The conversation's own stamp, not a settings read: titling fires from
  // engine events, where there is no client request to ask.
  if (!conversationPreferencesFor(tabId).aiGeneratedTitles) {
    rDebug('event.title', 'AI titles are off; keeping the truncated title', { tab_id: tabId.slice(0, 8) })
    return
  }

  rDebug('event.title', 'generating AI title at send time', { tab_id: tabId.slice(0, 8) })
  generateTitle(text).then((title) => {
    if (!title) {
      // Nothing came back, so the truncated title stands on both surfaces.
      rDebug('event.title', 'no title generated; keeping the truncated title', { tab_id: tabId.slice(0, 8) })
      return
    }
    renameTab(tabId, title)
    seedWorktreeTitle(workingDirectory, title, fallbackTitle)
  }).catch((err) => {
    rWarn('event.title', 'AI title generation failed; keeping truncated fallback', {
      tab_id: tabId.slice(0, 8), error: String(err),
    })
  })
}

/**
 * Record a conversation's title on the worktree it is running in.
 *
 * A pure write, never a generation: the string was produced by the caller.
 * `gitWorktreeSeedTitle` owns the decision about whether it applies (registered
 * worktree? already named?), so this is deliberately thin — it forwards, and
 * reports what came back.
 *
 * `replaces` names the title this same conversation stamped earlier, which the
 * new one may take the place of.
 *
 * `'~'` is home, not a worktree, and is filtered here rather than round-tripping
 * to be refused.
 */
export function seedWorktreeTitle(workingDirectory: string, title: string, replaces?: string): void {
  if (!workingDirectory || workingDirectory === '~') {
    return
  }

  gitWorktreeSeedTitle(workingDirectory, title, replaces).then((result) => {
    // Both branches log: the no-op reason is what makes "why is this row still
    // a slug?" answerable from the log alone.
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

