/**
 * Latest-wins delivery of `studio:tabs-sync` pushes.
 *
 * Each push is a full snapshot of one Environment's tabs, so applying a push
 * that a newer one already replaced is wasted work: the newer one overwrites
 * all of it. When pushes arrive faster than the window applies them they
 * queue, and each queued push rebuilt the whole tab union before the next
 * could run, so the window fell further behind the server with every one.
 * Here a push waits one task. A push for the same Environment that arrives
 * meanwhile replaces it, and only the newest is applied.
 *
 * `settledHistory` rides a push only when it changed, so a replaced push that
 * carried it hands it to the push that replaces it.
 */
import { rDebug } from '../../rendererLogger'

type Apply = (payload: unknown, environmentId: string) => void

interface Waiting {
  payload: unknown
  superseded: number
}

export interface TabsSyncCoalescer {
  /** Queue one push; it is applied on the next task unless a newer one replaces it. */
  push(environmentId: string, payload: unknown): void
  /** Apply what waits for `environmentId` now, ahead of a frame that must follow it. */
  flush(environmentId: string): void
}

function carriesSettled(payload: unknown): payload is { settledHistory: unknown[] } {
  return typeof payload === 'object' && payload !== null && Array.isArray((payload as { settledHistory?: unknown }).settledHistory)
}

export function createTabsSyncCoalescer(apply: Apply): TabsSyncCoalescer {
  const waiting = new Map<string, Waiting>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function applyWaiting(environmentId: string): void {
    const entry = waiting.get(environmentId)
    if (!entry) return
    waiting.delete(environmentId)
    if (entry.superseded > 0) {
      rDebug('studio.mirror', 'tabs sync applied newest push, older ones skipped', { environment_id: environmentId, superseded: entry.superseded })
    }
    apply(entry.payload, environmentId)
  }

  function applyAll(): void {
    timer = null
    for (const environmentId of [...waiting.keys()]) applyWaiting(environmentId)
  }

  return {
    push(environmentId, payload) {
      const previous = waiting.get(environmentId)
      let next = payload
      if (previous && carriesSettled(previous.payload) && !carriesSettled(payload) && typeof payload === 'object' && payload !== null) {
        next = { ...payload, settledHistory: previous.payload.settledHistory }
      }
      waiting.set(environmentId, { payload: next, superseded: previous ? previous.superseded + 1 : 0 })
      if (timer === null) timer = setTimeout(applyAll, 0)
    },
    flush: applyWaiting,
  }
}
