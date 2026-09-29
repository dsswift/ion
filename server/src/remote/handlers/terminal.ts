import { IPC } from '@ion/shared/types'
import { log as _log } from '../../logger'
import { terminalScrollback } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal/terminal-manager-instance'
import { useSessionStore } from '../../store/sessionStore'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Create a terminal instance on a NAMED tab and start its PTY.
 *
 * Shared by the iOS `desktop_terminal_add_instance` command and the `ion://`
 * deep-link terminal action, so both get identical semantics rather than two
 * drifting implementations.
 *
 * Three properties matter and each is a fix for a real defect:
 *
 *  1. **The pane is marked OPEN.** This used to write `terminalPanes` only, so
 *     a tab ended up holding instances the panel did not render until the
 *     operator manually toggled the terminal — output streaming into a pane
 *     nobody could see.
 *  2. **The tab is resolved strictly by id, never by "active".** Returns
 *     `null` when `tabId` names no live tab so the caller can refuse. Silently
 *     retargeting the active tab is the stray-pane failure the deep-link
 *     surface exists to prevent: `dev run` in conversation A's shell must put
 *     its panes in A even when the operator has navigated to B.
 *  3. **Focus is not stolen.** The new instance becomes active WITHIN its own
 *     pane, but `activeTabId` is untouched, so a pane opening in a background
 *     conversation does not yank the operator out of the one they are reading.
 *
 * `label` is optional. When given (a deep link naming a service, e.g. `api`)
 * it replaces the auto-numbered `Shell N`; when absent the store's existing
 * numbering applies, which is what the iOS caller relies on.
 *
 * `cwd` is also optional. A deep link created by a service orchestrator supplies
 * the service directory, so a command such as `func start` or `dotnet watch
 * --project file.csproj` runs where its project files actually live rather than
 * at the parent conversation repository. iOS does not supply it and retains the
 * tab working-directory fallback.
 *
 * `launchKey` is also optional. It tags the pane with the identity of the
 * launch that created it, so a later launch with the same key can find and
 * reuse it (`relaunchTerminalInstanceOnTab`).
 *
 * Returns the created instance, or `null` when the renderer store is
 * unavailable or the tab does not exist.
 */
export async function createTerminalInstanceOnTab(
  tabId: string,
  opts: { label?: string; cwd?: string; launchKey?: string } = {},
): Promise<{ id: string; label: string; kind: string; cwd: string } | null> {
  let result: { id: string; label: string; kind: string; cwd: string } | 'no-such-tab' | null
  try {
    const s = useSessionStore.getState()
    // Resolve by id only. No fallback to the active tab: a caller that names
    // a dead tab must be refused, not silently redirected.
    if (!s.tabs.some((t) => t.id === tabId)) {
      result = 'no-such-tab'
    } else {
      const id = await s.addTerminalInstance(tabId, 'user', opts.cwd, opts.label, opts.launchKey)
      const pane = useSessionStore.getState().terminalPanes.get(tabId)
      const inst = pane?.instances.find((i) => i.id === id)
      result = inst ? { id: inst.id, label: inst.label, kind: inst.kind, cwd: inst.cwd || '' } : null
    }
  } catch (err) {
    log('terminal_add_instance failed: store request threw', { tabId, error: String(err) })
    return null
  }

  if (result === 'no-such-tab') {
    log('terminal_add_instance refused: no such tab', { tabId })
    return null
  }
  if (!result) {
    log('terminal_add_instance failed: instance not found after create', { tabId })
    return null
  }
  log('terminal_add_instance created', { tabId, instanceId: result.id, label: result.label, launchKey: opts.launchKey ?? '' })
  return result
}

/** The pane in `tabId` an earlier launch tagged with `launchKey`, or null. */
export function findTerminalInstanceByLaunchKey(tabId: string, launchKey: string): { id: string; label: string } | null {
  const inst = useSessionStore.getState().terminalPanes.get(tabId)?.instances.find((i) => i.launchKey === launchKey)
  return inst ? { id: inst.id, label: inst.label } : null
}

/**
 * Stop everything an existing pane runs and restart its shell, keeping the
 * pane. Same focus rule as creation: the pane becomes active within its own
 * conversation, and `activeTabId` is untouched. Throws when the pane is gone
 * or the new shell fails to start.
 */
export async function relaunchTerminalInstanceOnTab(
  tabId: string,
  instanceId: string,
  opts: { label?: string; cwd?: string } = {},
): Promise<{ id: string; label: string; cwd: string }> {
  await useSessionStore.getState().relaunchTerminalInstance(tabId, instanceId, opts.cwd, opts.label)
  const inst = useSessionStore.getState().terminalPanes.get(tabId)?.instances.find((i) => i.id === instanceId)
  if (!inst) throw new Error(`Terminal ${instanceId} closed during its relaunch.`)
  log('terminal_relaunch_instance completed', { tabId, instanceId, label: inst.label, cwd: inst.cwd })
  return { id: inst.id, label: inst.label, cwd: inst.cwd }
}

/**
 * Open a web application a terminal in `tabId` is serving, as a Studio
 * Browser Surface tab. Refused (false) unless a terminal of that tab still
 * owns `url`, so a client cannot make Studio open an address of its choosing.
 * One implementation for the `desktop_*` command and `terminal.openApplication`.
 */
export function openTerminalApplication(tabId: string, url: string): boolean {
  const cmd = { tabId, url }
  const activity = terminalManager.activitySnapshot().find((item) =>
    item.tabId === cmd.tabId && item.applications.some((application) => application.url === cmd.url),
  )
  if (!activity) {
    log('open_terminal_application refused: application is no longer owned', { tabId: cmd.tabId, url: cmd.url })
    return false
  }
  const application = activity.applications.find((item) => item.url === cmd.url)
  if (!application) return false
  try {
    // Bring the owning conversation forward first. The store's active tab is
    // what every Studio client follows (tabs-sync), so this is one forwarded
    // store action rather than a bespoke focus channel.
    useSessionStore.getState().selectTab(cmd.tabId)
    broadcast(IPC.STUDIO_OPEN_WEB_APPLICATION, { tabId: cmd.tabId, url: application.url })
    log('open_terminal_application routed to studio', { tabId: cmd.tabId, instanceId: activity.instanceId, url: application.url })
    return true
  } catch (err) {
    log('open_terminal_application failed', { tabId: cmd.tabId, url: application.url, error: String(err) })
    return false
  }
}

/** One conversation's terminal pane: every instance, the active one, and the scrollback this server holds for each. */
export interface TerminalPaneSnapshot {
  tabId: string
  instances: Array<{ id: string; label: string; kind: string; readOnly: boolean; cwd: string }>
  activeInstanceId: string | null
  buffers?: Record<string, string>
}

/**
 * Read a conversation's whole terminal pane. One implementation for the
 * `desktop_*` command and `terminal.paneSnapshot`.
 *
 * A tab whose terminal panel has never been opened has no pane. It gets the
 * default "Shell" instance (kind 'user') a panel creates on first mount, with
 * its cwd resolved from the tab's working directory, so the client has a shell
 * to show. Returns `null` when that tab does not exist or the create failed.
 */
export async function readTerminalPaneSnapshot(tabId: string): Promise<TerminalPaneSnapshot | null> {
  const pane = useSessionStore.getState().terminalPanes.get(tabId)
  if (pane) {
    const instances = pane.instances.map((inst) => (
      { id: inst.id, label: inst.label || inst.id, kind: inst.kind || 'user', readOnly: !!inst.readOnly, cwd: inst.cwd || '' }
    ))
    log('request_terminal_snapshot pane found', { tabId, instanceCount: instances.length })
    // A live xterm.js scrollback buffer exists only in a browser DOM, which
    // this process never has; the server-side accumulator is the source.
    const buffers: Record<string, string> = {}
    for (const inst of instances) {
      const scrollback = terminalScrollback.get(`${tabId}:${inst.id}`)
      if (scrollback) buffers[inst.id] = scrollback
    }
    return { tabId, instances, activeInstanceId: pane.activeInstanceId || null, buffers: Object.keys(buffers).length > 0 ? buffers : undefined }
  }
  const created = await createTerminalInstanceOnTab(tabId)
  if (!created) {
    log('request_terminal_snapshot pane missing and auto-create failed', { tabId })
    return null
  }
  log('request_terminal_snapshot pane missing, auto-created default instance', { tabId, instanceId: created.id, cwd: created.cwd || '~' })
  return {
    tabId,
    instances: [{ id: created.id, label: created.label || 'Shell', kind: created.kind || 'user', readOnly: false, cwd: created.cwd || '' }],
    activeInstanceId: created.id,
    buffers: undefined,
  }
}
