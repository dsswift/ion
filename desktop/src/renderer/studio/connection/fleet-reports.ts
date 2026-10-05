/**
 * fleet-reports — the newest `fleet.report` this device has read from each
 * server. One cache for every surface that needs a server's own account of
 * itself: the Fleet page shows it, and placement of a new conversation
 * scores it. A server that goes offline keeps its last report.
 */
import type { FleetReport } from '@ion/shared/types-fleet'
import { action } from '../../host/host-instance'
import { rWarn } from '../../rendererLogger'

export interface HeldFleetReport {
  report: FleetReport
  /** Unix ms this device read the report. */
  readAt: number
}

const held = new Map<string, HeldFleetReport>()
const failures = new Map<string, string>()

export function heldFleetReport(id: string): HeldFleetReport | undefined {
  return held.get(id)
}

/** Why the newest read from a server failed; undefined once a read succeeds. */
export function fleetReportFailure(id: string): string | undefined {
  return failures.get(id)
}

/** Reads one server's report into the cache. A failure is recorded and logged, never thrown. */
export async function readFleetReport(id: string): Promise<void> {
  try {
    const report = (await action(id, 'fleet.report', [])) as FleetReport
    held.set(id, { report, readAt: Date.now() })
    failures.delete(id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failures.set(id, message)
    rWarn('fleet.reports', 'fleet report read failed', { environment_id: id, error: message })
  }
}

/** TEST ONLY. */
export function _resetFleetReportsForTest(): void {
  held.clear()
  failures.clear()
}
