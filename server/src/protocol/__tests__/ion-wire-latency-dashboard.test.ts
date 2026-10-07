/**
 * The dashboard may only query fields something emits.
 *
 * This is the gap that let the previous Ion Wire Latency dashboard sit empty:
 * it queried `fields.queue_dwell_ms` and `fields.adj_latency_ms` off a
 * desktop→iOS transport that ADR-035 removed, nothing had written those fields
 * since, and an empty panel reads exactly like a quiet system. Its test checked
 * that the JSON contained those query strings -- which it did, forever.
 *
 * So this asserts the other direction: every `fields_*` the dashboard reads is
 * a field the server's window or a client's window actually carries.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { WIRE_WINDOW_FIELDS } from '../wire-latency'
import { CLIENT_WINDOW_FIELDS, ELECTRON_CLIENT_WINDOW_FIELDS } from '@ion/shared/client-wire-latency'

// server/src/protocol/__tests__/ → repo root
const DASHBOARD_PATH = join(
  __dirname,
  '../../../..',
  'docs/observability/grafana/provisioning/dashboards/reliability/ion-wire-latency.json',
)

function dashboardJson(): string {
  return readFileSync(DASHBOARD_PATH, 'utf-8')
}

/** Every `fields_<name>` the dashboard's queries and legends mention. */
function queriedFields(): string[] {
  const found = new Set<string>()
  for (const match of dashboardJson().matchAll(/fields_([a-z0-9_]+)/g)) found.add(match[1])
  return [...found].sort()
}

describe('ion-wire-latency Grafana dashboard', () => {
  it('exists and is valid JSON', () => {
    expect(existsSync(DASHBOARD_PATH)).toBe(true)
    expect(() => JSON.parse(dashboardJson())).not.toThrow()
  })

  it('queries only fields the server or a client actually emits', () => {
    const emitted = new Set<string>([...WIRE_WINDOW_FIELDS, ...CLIENT_WINDOW_FIELDS, ...ELECTRON_CLIENT_WINDOW_FIELDS])
    const orphans = queriedFields().filter((f) => !emitted.has(f))

    expect(
      orphans,
      `the dashboard reads fields nothing writes: ${orphans.join(', ')}. ` +
        'Either the emitter dropped them or the panel is querying a source that no longer exists -- ' +
        'an empty panel is indistinguishable from a quiet system.',
    ).toEqual([])
  })

  it('reads both windows, so the wire and the work can be told apart', () => {
    const raw = dashboardJson()
    expect(raw).toContain('wire window')
    expect(raw).toContain('client window')
    // The server's own lines, and each client's.
    expect(raw).toContain('service_name=\\"ion-server\\"')
    expect(raw).toContain('ion-(desktop|web|ios)')
  })

  it('names the round trip it measures, not the one it replaced', () => {
    const raw = dashboardJson()
    expect(raw).toContain('fields_rtt_p95_ms')
    // The removed transport's fields, gone for good.
    expect(raw).not.toContain('queue_dwell_ms')
    expect(raw).not.toContain('adj_latency_ms')
    expect(raw).not.toContain('skew_est_ms')
  })

  it('still states the iOS freshness caveat', () => {
    // iOS lines ride the diagnostic pull, so they lag; a reader comparing them
    // against live server lines has to know that.
    expect(dashboardJson()).toMatch(/30 s|~30s|diagnostic/)
  })
})
