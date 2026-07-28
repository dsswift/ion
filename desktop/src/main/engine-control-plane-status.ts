/**
 * Tab-map read projections for `EngineControlPlane`.
 *
 * Extracted from `engine-control-plane.ts` to keep it under the 600-line
 * TypeScript cap. These are pure reads over the tab map with no bridge I/O and
 * no mutation, which is exactly why they are the right thing to lift out: the
 * control plane's remaining bulk is lifecycle and dispatch, and a reader
 * looking for "how is health computed" should not have to scroll past the
 * prompt path to find it.
 */
import type { HealthReport } from '../shared/types'
import type { TabEntry } from './engine-control-plane-events'

/**
 * Project every tracked tab into the health report shape.
 *
 * `alive` is derived rather than stored: a tab is alive unless it reached a
 * terminal status. `queueDepth` is always 0 because the engine owns queueing —
 * the desktop dispatches straight through and has no queue of its own to
 * report.
 */
export function buildHealthReport(tabs: Map<string, TabEntry>): HealthReport {
  const projected: HealthReport['tabs'] = []
  for (const tab of tabs.values()) {
    projected.push({
      tabId: tab.tabId,
      status: tab.status,
      activeRequestId: tab.activeRequestId,
      conversationId: tab.conversationId,
      alive: tab.status !== 'dead' && tab.status !== 'failed',
      lastActivityAt: tab.lastActivityAt,
    })
  }
  return { tabs: projected, queueDepth: 0 }
}

/**
 * True when any tab is mid-flight. 'connecting' counts: the session is starting
 * and a prompt is already committed to it, so treating it as idle would let a
 * shutdown or drain race a run that is about to produce output.
 */
export function anyTabRunning(tabs: Map<string, TabEntry>): boolean {
  for (const tab of tabs.values()) {
    if (tab.status === 'running' || tab.status === 'connecting') {
      return true
    }
  }
  return false
}
