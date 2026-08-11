/**
 * `ion://terminal` — open a pane in a named conversation.
 *
 * ── Target resolution never falls back to the active tab ─────────────────────
 * `dev run` in conversation A's shell #1 must produce panes in A's terminal tab
 * and nowhere else, including when the operator has since navigated to B. So the
 * tab is resolved strictly from the id the request carries (inherited from the
 * issuing PTY's `ION_DESKTOP_TAB_ID`), and there are exactly three outcomes:
 *
 *   - id names a live tab  → pane opens there.
 *   - id names a dead tab  → REFUSED. The conversation was closed after the
 *                            shell started. Retargeting would drop a service's
 *                            output into an unrelated conversation.
 *   - id absent            → REFUSED here. The caller is not running inside an
 *                            Ion pane (a plain iTerm shell), so there is no
 *                            conversation to infer. The untrusted path asks the
 *                            operator to choose instead of guessing.
 *
 * "No tab named" is an error, never a default. Silently retargeting the active
 * tab is the stray-pane failure this whole surface exists to prevent.
 */

import { log as _log, warn as _warn } from '../logger'
import { createTerminalInstanceOnTab } from '../remote/handlers/terminal'
import { terminalManager } from '../terminal-manager-instance'
import type { TerminalRequest } from './parse'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export interface ActionOutcome {
  ok: boolean
  /** Operator-facing reason when refused; surfaced, never only logged. */
  error?: string
  /** Instance id of the created pane, for the caller's log line. */
  instanceId?: string
}

export async function runTerminalAction(req: TerminalRequest): Promise<ActionOutcome> {
  if (!req.tabId) {
    // Not a failure of the caller so much as a request that cannot be honoured
    // as-is: there is no conversation to open the pane in.
    warn('terminal action refused: no tabId', { title: req.title })
    return {
      ok: false,
      error: 'No conversation was named. Run this from a terminal inside an Ion conversation, '
        + 'or pass tabId explicitly.',
    }
  }

  try {
    const created = await createTerminalInstanceOnTab(req.tabId, {
      label: req.title || undefined,
      // `dev run` emits its resolved service directory here. It is not display
      // metadata: commands such as `func start` and `dotnet watch --project
      // file.csproj` resolve project files RELATIVE TO THEIR PROCESS DIRECTORY.
      // Dropping this made every spawned service inherit the conversation's repo
      // root, so both launched successfully but immediately failed to find their
      // own host.json / csproj. Empty keeps the ordinary tab-directory fallback.
      cwd: req.dir || undefined,
    })

    if (!created) {
      // createTerminalInstanceOnTab returns null for a dead tab or an unavailable
      // renderer store, and logs which. Either way the pane does not exist, and
      // the refusal is reported rather than silently dropped.
      warn('terminal action refused: target tab unavailable', { tabId: req.tabId })
      return {
        ok: false,
        error: `Conversation ${req.tabId} is no longer open, so the terminal could not be created.`,
      }
    }

    if (req.cmd) {
      // Written directly to the PTY rather than passed as an argv to the shell:
      // the pane is an interactive shell the operator can keep using afterwards,
      // and the command should appear in its history exactly as if typed.
      terminalManager.write(`${req.tabId}:${created.id}`, req.cmd + '\n')
    }

    log('terminal action completed', {
      tabId: req.tabId,
      instanceId: created.id,
      label: created.label,
      cwd: created.cwd,
      requested_cwd: req.dir,
      ran_command: !!req.cmd,
    })
    return { ok: true, instanceId: created.id }
  } catch (err) {
    warn('terminal action failed', { tabId: req.tabId, error: String(err) })
    return { ok: false, error: 'The terminal could not be created.' }
  }
}
