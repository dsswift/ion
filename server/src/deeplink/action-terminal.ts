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
 *
 * ── A launch key reuses its pane ─────────────────────────────────────────────
 * `dev run` launches the same services every time. Without an identity, each
 * run added one more pane per service beside the dead ones. A request carrying
 * `key` names its launch: when the target conversation already has a pane
 * tagged with that key, its processes are stopped and the pane is reused with
 * a fresh shell. Otherwise a new pane is created and tagged. Keys are scoped to
 * the conversation, never global. Requests for one key run one at a time, so a
 * double launch cannot open two panes for it.
 */

import { log as _log, warn as _warn } from '../logger'
import { createTerminalInstanceOnTab, findTerminalInstanceByLaunchKey, relaunchTerminalInstanceOnTab } from '../remote/handlers/terminal'
import { terminalManager } from '../terminal/terminal-manager-instance'
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

/** Launches under way, by `<tabId>\0<key>`. */
const launchesInFlight = new Map<string, Promise<ActionOutcome>>()

export function runTerminalAction(req: TerminalRequest): Promise<ActionOutcome> {
  if (!req.key || !req.tabId) return launchTerminal(req)
  const slot = `${req.tabId}\0${req.key}`
  const prior = launchesInFlight.get(slot)
  if (prior) log('terminal action waiting for the same launch key', { tabId: req.tabId, key: req.key })
  const next = (): Promise<ActionOutcome> => launchTerminal(req)
  const run = prior ? prior.then(next, next) : next()
  launchesInFlight.set(slot, run)
  const clear = (): void => { if (launchesInFlight.get(slot) === run) launchesInFlight.delete(slot) }
  void run.then(clear, clear)
  return run
}

async function launchTerminal(req: TerminalRequest): Promise<ActionOutcome> {
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

  if (req.key) {
    const existing = findTerminalInstanceByLaunchKey(req.tabId, req.key)
    if (existing) return relaunchTerminal(req, existing.id)
    log('terminal action: no pane holds this launch key; creating one', { tabId: req.tabId, key: req.key })
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
      launchKey: req.key || undefined,
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
      key: req.key,
      reused: false,
      ran_command: !!req.cmd,
    })
    return { ok: true, instanceId: created.id }
  } catch (err) {
    warn('terminal action failed', { tabId: req.tabId, error: String(err) })
    return { ok: false, error: 'The terminal could not be created.' }
  }
}

async function relaunchTerminal(req: TerminalRequest, instanceId: string): Promise<ActionOutcome> {
  log('terminal action: reusing the pane that holds this launch key', { tabId: req.tabId, key: req.key, instanceId })
  try {
    const relaunched = await relaunchTerminalInstanceOnTab(req.tabId, instanceId, {
      label: req.title || undefined,
      // Empty keeps the pane's own directory, exactly as creation keeps the tab's.
      cwd: req.dir || undefined,
    })
    if (req.cmd) terminalManager.write(`${req.tabId}:${relaunched.id}`, req.cmd + '\n')
    log('terminal action completed', {
      tabId: req.tabId,
      instanceId: relaunched.id,
      label: relaunched.label,
      cwd: relaunched.cwd,
      requested_cwd: req.dir,
      key: req.key,
      reused: true,
      ran_command: !!req.cmd,
    })
    return { ok: true, instanceId: relaunched.id }
  } catch (err) {
    warn('terminal action failed: relaunch', { tabId: req.tabId, instanceId, key: req.key, error: String(err) })
    return { ok: false, error: `The terminal for ${req.title || req.key} could not be restarted: ${String(err)}` }
  }
}
