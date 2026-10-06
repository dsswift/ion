import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TerminalActivity } from '@ion/shared/terminal-activity'
import type { EnvironmentPhase, EnvironmentPhaseState } from '@ion/shared/types-environments'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { explicitTargetEnvironment } from '../studio/connection/tab-environment'

type Phases = Map<string, EnvironmentPhaseState>
type LiveListener = (activity: TerminalActivity, environmentId: string) => void

const mocks = vi.hoisted(() => ({
  phaseListener: null as ((states: Map<string, unknown>) => void) | null,
  liveListener: null as ((activity: never, environmentId: string) => void) | null,
  /** What each Environment's server answers `terminal.activitySnapshot` with. */
  snapshots: new Map<string, Promise<unknown[]>>(),
}))

vi.mock('../studio/connection/registry', () => ({
  registry: {
    subscribe: (listener: (states: Map<string, unknown>) => void) => {
      mocks.phaseListener = listener
      return () => { mocks.phaseListener = null }
    },
  },
}))
vi.mock('../studio/connection/catalog', () => ({ isManageOnlyEnvironment: () => false }))
vi.mock('../host/host-instance', () => ({
  host: {
    shell: {
      terminalActivitySnapshot: () => mocks.snapshots.get(explicitTargetEnvironment() ?? 'local') ?? Promise.resolve([]),
      onTerminalActivity: (listener: LiveListener) => {
        mocks.liveListener = listener as never
        return () => { mocks.liveListener = null }
      },
    },
  },
}))

import { startTerminalActivitySync } from './terminal-activity-sync'

function activity(tabId: string, active = true): TerminalActivity {
  return {
    key: `${tabId}:shell-1`, tabId, instanceId: 'shell-1', active, processLabel: active ? 'dotnet' : null, processIds: active ? [10] : [],
    applications: active ? [{ id: 'native:10:7255', kind: 'web', url: 'http://localhost:7255', port: 7255, pid: 10, processName: 'Api', source: 'native' }] : [],
  }
}

function phases(entries: Record<string, EnvironmentPhase>): Phases {
  return new Map(Object.entries(entries).map(([id, phase]) => [id, { phase }]))
}

function running(): string[] {
  return [...useSessionStore.getState().terminalActivities.values()].filter((item) => item.active).map((item) => item.tabId).sort()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

let stop: () => void

beforeEach(() => {
  mocks.snapshots.clear()
  useSessionStore.setState({ terminalActivities: new Map() })
  stop = startTerminalActivitySync()
})

afterEach(() => stop())

describe('startTerminalActivitySync', () => {
  it('reads a remote Environment when it connects, so a shell started earlier shows', async () => {
    mocks.snapshots.set('local', Promise.resolve([activity('local-tab', false)]))
    mocks.snapshots.set('remote', Promise.resolve([activity('remote-tab')]))

    mocks.phaseListener?.(phases({ local: 'connected', remote: 'connected' }))
    await settle()

    expect(running()).toEqual(['remote-tab'])
  })

  it('drops an Environment that goes offline, and keeps the others', async () => {
    mocks.snapshots.set('local', Promise.resolve([activity('local-tab')]))
    mocks.snapshots.set('remote', Promise.resolve([activity('remote-tab')]))
    mocks.phaseListener?.(phases({ local: 'connected', remote: 'connected' }))
    await settle()

    mocks.phaseListener?.(phases({ local: 'connected', remote: 'offline' }))

    expect(running()).toEqual(['local-tab'])
  })

  it('replaces what an Environment reported before with its fresh list on reconnect', async () => {
    mocks.phaseListener?.(phases({ remote: 'connected' }))
    await settle()
    mocks.liveListener?.(activity('remote-tab') as never, 'remote')
    expect(running()).toEqual(['remote-tab'])

    // The shell stopped while this window was disconnected, so no live event cleared it.
    mocks.phaseListener?.(phases({ remote: 'backoff' }))
    mocks.snapshots.set('remote', Promise.resolve([]))
    mocks.phaseListener?.(phases({ remote: 'connected' }))
    await settle()

    expect(running()).toEqual([])
  })

  it('keeps a live event that lands while the read is in flight', async () => {
    let answer: (activities: TerminalActivity[]) => void = () => {}
    mocks.snapshots.set('remote', new Promise((resolve) => { answer = resolve }))
    mocks.phaseListener?.(phases({ remote: 'connected' }))

    mocks.liveListener?.(activity('remote-tab', false) as never, 'remote')
    answer([activity('remote-tab')])
    await settle()

    expect(running()).toEqual([])
  })
})
