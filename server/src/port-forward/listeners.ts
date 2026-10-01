/**
 * listeners — what is listening on this host, for a client choosing a port to
 * forward (`port.listeners`).
 *
 * Every loopback or wildcard TCP listener this process can see is reported,
 * not only the ones a Terminal owns: a service started by a container, or by
 * a Terminal in another conversation, is still something the operator may
 * need to reach. Terminal ownership and a confirmed Web Application URL are
 * added from Terminal Activity when they are known.
 */
import type { PortListener } from '@ion/shared/port-forward'
import type { TerminalActivity } from '@ion/shared/terminal-activity'
import type { LocalListener } from '../terminal/terminal-application-discovery'

/**
 * One row per port, lowest first. `mayNameTab` decides whether the caller is
 * told which conversation owns a listener.
 */
export function describePortListeners(
  listeners: readonly LocalListener[],
  activities: readonly TerminalActivity[],
  mayNameTab: (tabId: string) => boolean,
): PortListener[] {
  const ownerByPid = new Map<number, TerminalActivity>()
  const urlByPort = new Map<number, { url: string; tabId: string }>()
  for (const activity of activities) {
    for (const pid of activity.processIds) ownerByPid.set(pid, activity)
    for (const application of activity.applications) urlByPort.set(application.port, { url: application.url, tabId: activity.tabId })
  }
  const byPort = new Map<number, PortListener>()
  for (const listener of listeners) {
    const web = urlByPort.get(listener.port)
    const ownerTabId = ownerByPid.get(listener.pid)?.tabId ?? web?.tabId ?? null
    const tabId = ownerTabId !== null && mayNameTab(ownerTabId) ? ownerTabId : null
    const row: PortListener = { port: listener.port, pid: listener.pid, processName: listener.processName, tabId, url: web?.url ?? null }
    const existing = byPort.get(listener.port)
    // lsof reports one row per address family; keep the one that names an owner.
    if (!existing || (existing.tabId === null && row.tabId !== null)) byPort.set(listener.port, row)
  }
  // A container's published port is confirmed by Terminal Activity without a listener row of its own.
  for (const [port, web] of urlByPort) {
    if (byPort.has(port)) continue
    byPort.set(port, { port, pid: null, processName: null, tabId: mayNameTab(web.tabId) ? web.tabId : null, url: web.url })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}
