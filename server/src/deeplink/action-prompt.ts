/**
 * `ion://prompt` — open a conversation in a directory and put a prompt in it.
 *
 * This is the action behind a shareable link: an internal wiki or SharePoint
 * page can publish "open this repo and ask this question", and a recipient gets
 * a real conversation rather than instructions to copy and paste.
 *
 * ── Why this reuses the store's own actions ───────────────────────────────────
 * Conversation creation is not a single write. `createTabInDirectory` resolves a
 * worktree BEFORE the tab exists (the engine pins a session's working directory
 * at start_session, so a tab created first and moved afterwards leaves the
 * session in the wrong checkout — that is how five conversations once shared one
 * checkout), seeds the pane, and starts the engine session. `submit` runs the
 * prompt pipeline: slash resolution, the optimistic user bubble, the iOS echo.
 * Reimplementing either here would fork behaviour that already exists and drift
 * from it. So this action drives the same store actions the UI drives — on the
 * desktop this reached them via `executeJavaScript` on the renderer window; the
 * server owns the store directly in this process, so it is a plain call.
 *
 * ── Why the trust gate lives upstream ────────────────────────────────────────
 * Nothing here checks trust. `dispatch.ts` has already either validated the
 * capability token or obtained explicit operator approval, so by the time this
 * runs the request is authorised. Keeping the check in one place is what stops a
 * second action from being added later without one.
 *
 * ── Surfacing a window is a client concern ───────────────────────────────────
 * The desktop's version calls `showWindow()` here so the operator SEES the new
 * conversation. The server has no window of its own; a Studio client attached
 * over the wire (child 07) is what decides whether and how to bring itself to
 * the front for a request it receives.
 */

import { log as _log, warn as _warn } from '../logger'
import type { PromptRequest } from './parse'
import type { ActionOutcome } from './action-terminal'
import { useSessionStore } from '../store/sessionStore'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export async function runPromptAction(req: PromptRequest): Promise<ActionOutcome> {
  const s = useSessionStore.getState()
  if (typeof s.createTabInDirectory !== 'function') {
    warn('prompt action refused: store unavailable')
    return { ok: false, error: 'Ion is not ready yet.' }
  }

  try {
    // skipDuplicateCheck=true: a deep link is an explicit request for a
    // FRESH conversation. Reusing a blank tab would drop the prompt into
    // whatever the operator already had open.
    const tabId = await s.createTabInDirectory(req.dir, undefined, true)
    if (!tabId) {
      warn('prompt action failed', { dir: req.dir, error: 'tab creation returned no id' })
      return { ok: false, error: 'The conversation could not be created.' }
    }

    if (req.submit) {
      useSessionStore.getState().submit(tabId, req.text)
    } else {
      // Leave it in the composer so the operator can edit before sending.
      useSessionStore.getState().setDraftInput(tabId, req.text)
    }

    log('prompt action completed', {
      dir: req.dir,
      tabId,
      submitted: req.submit,
      text_length: req.text.length,
    })
    return { ok: true, tabId }
  } catch (err) {
    warn('prompt action threw', { dir: req.dir, error: String(err) })
    return { ok: false, error: String(err) }
  }
}
