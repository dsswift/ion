/**
 * Tests for the terminal activity poll's handling of a shell that ends while
 * the poll is waiting on web application discovery.
 *
 * The poll measures every live shell, then awaits the (slow) listener scan.
 * A terminal closed in that window has already cleared its activity. If the
 * poll then publishes its measurement, the closed shell comes back as running,
 * with its web applications, and nothing ever clears it again: the Inbox shows
 * a running app that does not exist.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '@ion/shared/types'
import type { TerminalActivity, TerminalWebApplication } from '@ion/shared/terminal-activity'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
}))

vi.mock('../../cli-env', () => ({
  getCliEnv: (extra?: Record<string, string>) => ({ PATH: '/usr/bin', ...extra }),
}))
vi.mock('../../deeplink/token', () => ({ getDeepLinkToken: () => 'test-token-value' }))
vi.mock('../../state', () => ({ terminalScrollback: new Map<string, string>() }))
vi.mock('../../logger', () => ({ log: () => {}, warn: () => {}, debug: () => {}, error: () => {} }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: () => true }
})
vi.mock('../terminal-stop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-stop')>()
  return { ...actual, readProcessSnapshot: () => Promise.resolve({ childrenByParent: new Map(), processes: new Map() }) }
})
// Every shell is busy running `dotnet`.
vi.mock('../terminal-process-tree', () => ({
  terminalProcessTree: (_snapshot: unknown, pid: number) => ({ active: true, processIds: [pid, pid + 1], processLabel: 'dotnet' }),
}))
vi.mock('../terminal-application-discovery', () => ({ discoverTerminalWebApplications: mocks.discover }))

import { TerminalManager } from '../terminal-manager'

function fakeSpawner() {
  return () => ({
    pid: 4242, process: '/bin/zsh',
    onData: () => {}, onExit: () => {}, write: () => {},
    resize: () => {}, kill: () => {},
  }) as never
}

const KEY = 'tab-abc:inst-1'
const APP: TerminalWebApplication = { id: 'native:4243:7255', kind: 'web', url: 'http://localhost:7255', port: 7255, pid: 4243, processName: 'Api', source: 'native' }

/** Lets the poll run up to (and past) its awaits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('TerminalManager activity poll', () => {
  beforeEach(() => {
    mocks.discover.mockReset()
  })

  it('does not re-add a running activity for a terminal destroyed during web discovery', async () => {
    let finishDiscovery: (apps: Map<string, TerminalWebApplication[]>) => void = () => {}
    mocks.discover.mockReturnValue(new Promise((resolve) => { finishDiscovery = resolve }))
    const published: TerminalActivity[] = []
    const manager = new TerminalManager((channel, ...args) => {
      if (channel === IPC.TERMINAL_ACTIVITY) published.push(args[0] as TerminalActivity)
    }, fakeSpawner())

    manager.create(KEY, '/repo')
    await settle()
    expect(mocks.discover).toHaveBeenCalledTimes(1)

    manager.destroy(KEY)
    finishDiscovery(new Map([[KEY, [APP]]]))
    await settle()

    expect(manager.activitySnapshot()).toEqual([])
    expect(published.filter((activity) => activity.active)).toEqual([])
  })

  it('still publishes the measurement for a terminal that is still open', async () => {
    mocks.discover.mockResolvedValue(new Map([[KEY, [APP]]]))
    const manager = new TerminalManager(() => {}, fakeSpawner())

    manager.create(KEY, '/repo')
    await settle()

    expect(manager.activitySnapshot()).toEqual([expect.objectContaining({ key: KEY, active: true, processLabel: 'dotnet', applications: [APP] })])
    manager.destroy(KEY)
  })
})
