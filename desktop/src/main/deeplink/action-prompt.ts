/**
 * `ion://prompt` — open a conversation in a directory and put a prompt in it.
 *
 * This is the action behind a shareable link: an internal wiki or SharePoint
 * page can publish "open this repo and ask this question", and a recipient gets
 * a real conversation rather than instructions to copy and paste.
 *
 * ── Why this reuses the renderer's own store actions ─────────────────────────
 * Conversation creation is not a single write. `createTabInDirectory` resolves a
 * worktree BEFORE the tab exists (the engine pins a session's working directory
 * at start_session, so a tab created first and moved afterwards leaves the
 * session in the wrong checkout — that is how five conversations once shared one
 * checkout), seeds the pane, and starts the engine session. `submit` runs the
 * prompt pipeline: slash resolution, the optimistic user bubble, the iOS echo.
 * Reimplementing either here would fork behaviour that already exists and drift
 * from it. So this action drives the same actions the UI drives.
 *
 * ── Why the trust gate lives upstream ────────────────────────────────────────
 * Nothing here checks trust. `dispatch.ts` has already either validated the
 * capability token or obtained explicit operator approval, so by the time this
 * runs the request is authorised. Keeping the check in one place is what stops a
 * second action from being added later without one.
 */

import { log as _log, warn as _warn } from '../logger'
import { state } from '../state'
import { showWindow } from '../window-manager'
import type { PromptRequest } from './parse'
import type { ActionOutcome } from './action-terminal'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export async function runPromptAction(req: PromptRequest): Promise<ActionOutcome> {
  if (!state.mainWindow) {
    warn('prompt action refused: no window')
    return { ok: false, error: 'Ion is not ready yet.' }
  }

  // A prompt link is the operator asking for a conversation they intend to read,
  // so unlike a background terminal pane this one does surface the window.
  showWindow('deeplink prompt')

  const dir = JSON.stringify(req.dir)
  const text = JSON.stringify(req.text)
  const submit = req.submit ? 'true' : 'false'

  try {
    const result = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return { ok: false, error: 'renderer store unavailable' };
        var s = store.getState();
        if (typeof s.createTabInDirectory !== 'function') {
          return { ok: false, error: 'createTabInDirectory unavailable' };
        }
        // skipDuplicateCheck=true: a deep link is an explicit request for a
        // FRESH conversation. Reusing a blank tab would drop the prompt into
        // whatever the operator already had open.
        return s.createTabInDirectory(${dir}, undefined, true).then(function(tabId) {
          if (!tabId) return { ok: false, error: 'tab creation returned no id' };
          if (${submit}) {
            store.getState().submit(tabId, ${text});
          } else {
            // Leave it in the composer so the operator can edit before sending.
            var setDraft = store.getState().setDraftInput;
            if (typeof setDraft === 'function') setDraft(tabId, ${text});
          }
          return { ok: true, tabId: tabId };
        }).catch(function(e) {
          return { ok: false, error: String(e) };
        });
      })()
    `)

    if (!result?.ok) {
      warn('prompt action failed', { dir: req.dir, error: result?.error ?? 'unknown' })
      return { ok: false, error: result?.error ?? 'The conversation could not be created.' }
    }

    log('prompt action completed', {
      dir: req.dir,
      tabId: result.tabId,
      submitted: req.submit,
      text_length: req.text.length,
    })
    return { ok: true }
  } catch (err) {
    warn('prompt action threw', { dir: req.dir, error: String(err) })
    return { ok: false, error: String(err) }
  }
}
