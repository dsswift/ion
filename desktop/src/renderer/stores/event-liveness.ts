// event-liveness.ts — arrival-time clock for the stuck-tab watchdog.
//
// `lastEventAt` belongs to renderer state and updates when the event reducer
// applies work inside requestAnimationFrame. Electron may suspend animation
// frames while a window is hidden or occluded even as IPC events continue to
// arrive. The watchdog must measure transport liveness, not render progress,
// so it reads this independent arrival clock as a floor under `lastEventAt`.

const arrivals = new Map<string, number>()

/** Record inbound engine activity before it waits for a renderer frame. */
export function markEventArrival(tabId: string, now = Date.now()): void {
  arrivals.set(tabId, now)
}

/** Most recent IPC arrival for this tab, if any. */
export function lastArrivalAt(tabId: string): number | null {
  return arrivals.get(tabId) ?? null
}

/** Remove clocks for closed tabs so long-lived desktop processes do not leak ids. */
export function pruneEventLiveness(liveTabIds: Iterable<string>): void {
  const live = new Set(liveTabIds)
  for (const tabId of arrivals.keys()) {
    if (!live.has(tabId)) arrivals.delete(tabId)
  }
}
