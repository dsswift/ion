/**
 * ion-wire-latency-dashboard.test.ts
 *
 * Pinning test for feat(docs): Grafana wire-latency dashboard.
 *
 * Verifies that the dashboard JSON:
 * 1. Exists and is valid JSON
 * 2. Contains per-event_type latency panels (adj_latency_ms queries)
 * 3. Contains a DECODE-ERR drop-rate panel
 * 4. Documents the freshness caveat (~30 s pull interval)
 * 5. Has the correct Loki datasource and tag fields from commit 9
 *
 * Failure mode without the fix: the dashboard file would not exist,
 * so no Grafana visualization of wire latency would be available.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const DASHBOARD_PATH = join(
  __dirname,
  // From desktop/src/main/remote/__tests__/ → ion/
  // Level 1: __tests__ → remote
  // Level 2: remote → main
  // Level 3: main → src
  // Level 4: src → desktop
  // Level 5: desktop → ion  ← this is the repo root
  '../../../../..',
  'docs/observability/grafana/provisioning/dashboards/reliability/ion-wire-latency.json',
)

describe('ion-wire-latency Grafana dashboard', () => {
  it('exists as a JSON file', () => {
    expect(existsSync(DASHBOARD_PATH)).toBe(true)
  })

  it('is valid JSON', () => {
    const raw = readFileSync(DASHBOARD_PATH, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('has correct metadata (title, uid, tags)', () => {
    const d = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf-8'))
    expect(d.title).toBe('Ion Wire Latency')
    expect(d.uid).toBe('ion-wire-latency-001')
    expect(d.tags).toContain('ion')
    expect(d.tags).toContain('latency')
  })

  it('has at least one panel querying adj_latency_ms (iOS receive latency)', () => {
    const d = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf-8'))
    const panels = d.panels as any[]
    const hasAdjLatency = panels.some((p) =>
      JSON.stringify(p).includes('adj_latency_ms'),
    )
    expect(hasAdjLatency).toBe(true)
  })

  it('has at least one panel querying queue_dwell_ms (desktop send)', () => {
    const d = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf-8'))
    const panels = d.panels as any[]
    const hasDwell = panels.some((p) =>
      JSON.stringify(p).includes('queue_dwell_ms'),
    )
    expect(hasDwell).toBe(true)
  })

  it('has a DECODE-ERR panel (drop rate)', () => {
    const d = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf-8'))
    const panels = d.panels as any[]
    const decodePanel = panels.find((p) =>
      typeof p.title === 'string' && p.title.toUpperCase().includes('DECODE-ERR'),
    )
    expect(decodePanel).toBeDefined()
    // The panel should query both desktop and iOS error logs.
    const panelStr = JSON.stringify(decodePanel)
    expect(panelStr).toContain('desktop')
    expect(panelStr).toContain('ios')
  })

  it('documents the freshness caveat (30 s pull interval)', () => {
    const raw = readFileSync(DASHBOARD_PATH, 'utf-8')
    // The freshness caveat must appear somewhere in the dashboard
    // (description or a text panel) to inform users of data staleness.
    expect(raw.toLowerCase()).toContain('30')
    expect(raw.toLowerCase()).toMatch(/freshness|stale|pull interval/i)
  })

  it('uses Loki as the datasource', () => {
    const d = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf-8'))
    const panels = d.panels as any[]
    const hasLoki = panels.some((p) =>
      JSON.stringify(p.datasource ?? p.targets ?? '').includes('loki'),
    )
    expect(hasLoki).toBe(true)
  })

  it('queries transport-frame tag (commit 9 desktop send logs)', () => {
    const d = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf-8'))
    const dashStr = JSON.stringify(d)
    expect(dashStr).toContain('transport-frame')
  })
})
