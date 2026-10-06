import type { TerminalActivity } from '@ion/shared/terminal-activity'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { host } from '../host/host-instance'
import { registry } from '../studio/connection/registry'
import { isManageOnlyEnvironment } from '../studio/connection/catalog'
import { withTargetEnvironment } from '../studio/connection/tab-environment'
import { rDebug, rWarn } from '../rendererLogger'

const REACHABLE_PHASES = new Set(['connected', 'degraded'])

/**
 * Keep the store's `terminalActivities` the union of every reachable
 * Environment's running terminals.
 *
 * Each Environment's server owns its terminals, and `ion:terminal-activity`
 * only reports a change. So each Environment's full list is read every time
 * it becomes reachable: a shell that started before this window connected
 * would otherwise never show. An Environment that stops being reachable
 * takes its entries with it, because nothing could clear them while it is
 * gone; its next connection reads them fresh.
 *
 * Returns the stop function.
 */
export function startTerminalActivitySync(): () => void {
  /** The Environment that reported each activity key. */
  const owners = new Map<string, string>()
  /** Keys heard live while an Environment's read was in flight, by Environment. A live event is newer than the read. */
  const heardDuringRead = new Map<string, Set<string>>()
  const reachable = new Set<string>()
  let stopped = false

  const applyLive = (activity: TerminalActivity, environmentId: string): void => {
    owners.set(activity.key, environmentId)
    heardDuringRead.get(environmentId)?.add(activity.key)
    useSessionStore.setState((state) => {
      const terminalActivities = new Map(state.terminalActivities)
      if (activity.active) terminalActivities.set(activity.key, activity)
      else terminalActivities.delete(activity.key)
      return { terminalActivities }
    })
  }

  /** Remove every entry `environmentId` reported, except the keys in `keep`. */
  const dropOwned = (terminalActivities: Map<string, TerminalActivity>, environmentId: string, keep: ReadonlySet<string>): number => {
    let dropped = 0
    for (const [key, owner] of owners) {
      if (owner !== environmentId || keep.has(key)) continue
      owners.delete(key)
      if (terminalActivities.delete(key)) dropped++
    }
    return dropped
  }

  const read = (environmentId: string): void => {
    const heard = new Set<string>()
    heardDuringRead.set(environmentId, heard)
    void withTargetEnvironment(environmentId, () => host.shell.terminalActivitySnapshot())
      .then((activities) => {
        // Disconnected, or reconnected and read again, while this was in flight.
        if (stopped || heardDuringRead.get(environmentId) !== heard) return
        heardDuringRead.delete(environmentId)
        let running = 0
        let dropped = 0
        useSessionStore.setState((state) => {
          const terminalActivities = new Map(state.terminalActivities)
          dropped = dropOwned(terminalActivities, environmentId, heard)
          for (const activity of activities) {
            if (heard.has(activity.key) || !activity.active) continue
            owners.set(activity.key, environmentId)
            terminalActivities.set(activity.key, activity)
            running++
          }
          return { terminalActivities }
        })
        rDebug('terminal', 'terminal activity snapshot applied', { environment_id: environmentId, running, dropped, heard_live: heard.size })
      })
      .catch((err: unknown) => rWarn('terminal', 'terminal activity snapshot failed', { environment_id: environmentId, error: String(err) }))
  }

  const forget = (environmentId: string): void => {
    heardDuringRead.delete(environmentId)
    let dropped = 0
    useSessionStore.setState((state) => {
      const terminalActivities = new Map(state.terminalActivities)
      dropped = dropOwned(terminalActivities, environmentId, new Set())
      return { terminalActivities }
    })
    rDebug('terminal', 'terminal activity dropped for unreachable environment', { environment_id: environmentId, dropped })
  }

  const unsubscribeActivity = host.shell.onTerminalActivity(applyLive)
  // `registry.subscribe` replays the current phases at once, so an
  // Environment that connected before this ran is read on the first call.
  const unsubscribeRegistry = registry.subscribe((states) => {
    for (const [environmentId, state] of states) {
      const isReachable = REACHABLE_PHASES.has(state.phase) && !isManageOnlyEnvironment(environmentId)
      if (isReachable && !reachable.has(environmentId)) {
        reachable.add(environmentId)
        read(environmentId)
      } else if (!isReachable && reachable.has(environmentId)) {
        reachable.delete(environmentId)
        forget(environmentId)
      }
    }
  })

  return () => {
    stopped = true
    unsubscribeRegistry()
    unsubscribeActivity()
  }
}
