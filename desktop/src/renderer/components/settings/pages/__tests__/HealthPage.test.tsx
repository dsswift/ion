// @vitest-environment jsdom
/**
 * HealthPage — renders from the metrics watch reply with engine and server
 * first; this device's Studio processes join the list on the local server
 * and stand apart on a remote one; a live sample updates the meters; both
 * watches stop on unmount; telemetry replays from the welcome; a missing
 * tool explains itself; a log opens in a side panel.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { EnvironmentSystemMetrics } from '@ion/shared/types-system-metrics'
import type { DeviceMetricsSample } from '@ion/shared/types-device-metrics'
import { createHarness, flush, type Harness } from './page-harness'

const wire = vi.hoisted(() => ({
  actions: [] as Array<{ env: string; name: string; args: unknown[] }>,
  frames: new Set<(env: string, frame: unknown) => void>(),
  deviceWatch: [] as boolean[],
  deviceSample: null as unknown,
  latest: null as unknown,
}))

vi.mock('../../../../host/host-instance', () => ({
  action: vi.fn(async (env: string, name: string, args: unknown[]) => {
    wire.actions.push({ env, name, args })
    if (name === 'environment.systemMetrics.watch') return { latest: wire.latest, watching: (args[0] as { on: boolean }).on }
    if (name === 'environment.systemMetrics.history') return { buckets: [], windowMs: 900_000 }
    if (name === 'environment.host.toolchains') return { tools: [{ name: 'git', path: '/usr/bin/git', version: 'git version 2.44.0' }, { name: 'go', path: null, version: null }] }
    if (name === 'environment.server.logTail') return { path: '/h/.ion/engine.jsonl', lines: ['{"msg":"one"}', '{"msg":"two"}'] }
    return null
  }),
  host: {
    capabilities: () => ['nativeShell'],
    onFrame: (cb: (env: string, frame: unknown) => void) => { wire.frames.add(cb); return () => wire.frames.delete(cb) },
    getEnvCache: vi.fn(async () => ({ welcome: { type: 'studio_welcome', snapshot: { telemetryHealth: [
      { target: 'http', queuedEvents: 12, queuedBytes: 2048, oldestAgeMs: 0, percentOfSoftWarn: 0, healthy: false, critical: false, stuck: true, maxAttempts: 3, quarantinedEvents: 0, quarantinedBytes: 0, updatedAt: 1 },
    ] } } })),
    shell: {
      deviceMetricsWatch: vi.fn(async (on: boolean) => { wire.deviceWatch.push(on); return wire.deviceSample }),
      onDeviceMetrics: vi.fn(() => () => {}),
    },
  },
}))
vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../../studio/connection/catalog', () => ({ readCatalog: vi.fn(async () => []), addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {} }))
vi.mock('../../../../studio/connection/registry', () => ({ registry: { phaseStates: () => new Map(), subscribe: () => () => {}, connectAll: vi.fn(), forget: vi.fn() } }))

const { HealthPage } = await import('../HealthPage')
const { SettingsEnvironmentProvider } = await import('../../settings-servers')

function sample(at: number, cpu: number): EnvironmentSystemMetrics {
  return {
    sampledAt: at, intervalMs: 1000, serverEventLoopUtilization: 0.1,
    host: { cpuUtilization: cpu, cpuCount: 8, effectiveCpuCount: 8, memoryTotalBytes: 16 * 1024 ** 3, memoryAvailableBytes: 4 * 1024 ** 3, memoryLimitBytes: 0, containerLimited: false, load1: 1.5, diskPath: '/', diskTotalBytes: 100, diskFreeBytes: 40 },
    processes: [
      { pid: 2, startTimeMs: 1, role: 'mcp', name: 'fixture-server', cpuPercent: 1, cpuTimeMs: 1, rssBytes: 10 * 1024 ** 2 },
      { pid: 1, startTimeMs: 1, role: 'engine', name: 'ion', cpuPercent: 3, cpuTimeMs: 1, rssBytes: 200 * 1024 ** 2 },
      { pid: 3, startTimeMs: 1, role: 'server', name: 'ion-server', cpuPercent: 2, cpuTimeMs: 1, rssBytes: 150 * 1024 ** 2 },
    ],
    runtime: { heapBytes: 0, sysBytes: 0, memLimitBytes: 0, goroutines: 1, numGC: 0, sessions: 0 },
  }
}
const device: DeviceMetricsSample = {
  sampledAt: 1, intervalMs: 1000, focused: true, systemIdleState: 'active',
  processes: [{ pid: 9, type: 'gpu', name: 'gpu-helper', cpuPercent: 1, rssBytes: 50 * 1024 ** 2, gpuPercent: 3 }],
}
const local: EnvironmentCatalogEntry = { id: 'local', label: 'This Mac', target: { kind: 'local' } }
const remote: EnvironmentCatalogEntry = { id: 'env-1', label: 'devbox', target: { kind: 'paired', label: 'devbox', url: 'http://127.0.0.1:1', credentialRef: 'c', via: 'lan' } }

let h: Harness
async function mount(entry: EnvironmentCatalogEntry): Promise<void> {
  await h.render(<SettingsEnvironmentProvider entry={entry}><HealthPage /></SettingsEnvironmentProvider>)
  await act(async () => { await flush(); await flush() })
}
const firstCells = (list: string): string[] => [...h.container.querySelectorAll(`section[aria-label="${list}"] [role="listitem"]`)].map((row) => row.firstElementChild?.textContent ?? '')
const watches = (): unknown[] => wire.actions.filter((a) => a.name === 'environment.systemMetrics.watch').map((a) => a.args[0])

beforeEach(() => {
  wire.actions = []; wire.frames.clear(); wire.deviceWatch = []; wire.latest = sample(1_000, 0.25); wire.deviceSample = device
  h = createHarness()
})
afterEach(() => h.unmount())

describe('HealthPage', () => {
  it('renders from the watch reply, engine and server first, with this device in the list when local', async () => {
    await mount(local)
    expect(h.container.querySelector('[aria-label="CPU 25%"]')).not.toBeNull()
    expect(firstCells('Processes')).toEqual(['engine', 'server', 'studio', 'mcp'])
    expect(h.container.querySelector('section[aria-label="Processes"]')?.textContent).toContain('3%')
    expect(h.container.querySelector('section[aria-label="This device"]')).toBeNull()
    expect(h.container.querySelector('[data-settings-anchor="telemetry"]')?.textContent).toContain('stuck')
    expect(h.container.textContent).toContain('12 queued · 2 KB')
  })

  it('shows this device apart from a remote server', async () => {
    await mount(remote)
    expect(firstCells('Processes')).not.toContain('studio')
    expect(firstCells('This device')).toEqual(['studio'])
  })

  it('updates on a live sample and stops both watches on unmount', async () => {
    await mount(local)
    expect(watches()).toEqual([{ on: true }])
    expect(wire.deviceWatch).toEqual([true])
    await act(async () => {
      for (const cb of wire.frames) cb('local', { type: 'studio_event', channel: 'ion:system-metrics', payload: sample(2_000, 0.8) })
      await flush()
    })
    expect(h.container.querySelector('[aria-label="CPU 80%"]')).not.toBeNull()
    h.unmount()
    await act(async () => { await flush() })
    expect(watches()).toEqual([{ on: true }, { on: false }])
    expect(wire.deviceWatch).toEqual([true, false])
    h = createHarness()
  })

  it('lists the host tools and explains a missing one', async () => {
    await mount(local)
    const tools = h.container.querySelector('section[aria-label="Tools on the host"]')!
    expect(tools.textContent).toContain('2.44.0')
    expect(tools.textContent).toContain('missing')
    expect(tools.textContent).toContain('A project setup that needs a missing tool will fail there')
  })

  it('opens a log tail in a side panel', async () => {
    await mount(local)
    const view = [...h.container.querySelectorAll('[data-settings-anchor="logs"] button')][0] as HTMLButtonElement
    await act(async () => { view.click(); await flush(); await flush() })
    expect(wire.actions).toContainEqual({ env: 'local', name: 'environment.server.logTail', args: [{ file: 'engine', lines: 200 }] })
    expect(h.container.querySelector('[aria-label="engine log tail"]')?.textContent).toBe('{"msg":"one"}\n{"msg":"two"}')
  })
})
