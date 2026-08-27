import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureTerminalWebApplicationDiscoveryForTests,
  discoverTerminalWebApplications,
} from '../terminal-application-discovery'
import { parseProcessTree, terminalProcessTree } from '../terminal-process-tree'
import type { TerminalActivity } from '../../shared/terminal-activity'

const activity: TerminalActivity = {
  key: 'tab-1:terminal-1',
  tabId: 'tab-1',
  instanceId: 'terminal-1',
  active: true,
  processLabel: 'npm',
  processIds: [98127, 98238, 98265],
  applications: [],
}

function listenerOutput(): string {
  return ['p98265', 'cnode', 'n127.0.0.1:5173'].join('\n')
}

afterEach(() => configureTerminalWebApplicationDiscoveryForTests({}))

describe('Terminal Web Application discovery', () => {
  it('attributes a confirmed nested listener to its owning Terminal', async () => {
    const snapshot = parseProcessTree(['98127 97544 /bin/zsh', '98238 98127 npm run dev', '98265 98238 node'].join('\n'))
    expect(terminalProcessTree(snapshot, 98127)).toEqual({
      active: true,
      processLabel: 'npm run dev',
      processIds: [98127, 98238, 98265],
    })
    configureTerminalWebApplicationDiscoveryForTests({
      listListeners: async () => listenerOutput(),
      probeWeb: async (url) => url === 'http://localhost:5173',
    })

    const applications = await discoverTerminalWebApplications([activity])

    expect(applications.get(activity.key)).toEqual([expect.objectContaining({
      url: 'http://localhost:5173', pid: 98265, source: 'native',
    })])
  })

  it('accepts a redirect confirmation', async () => {
    configureTerminalWebApplicationDiscoveryForTests({
      listListeners: async () => listenerOutput(),
      probeWeb: async (url) => url === 'https://localhost:5173',
    })

    const applications = await discoverTerminalWebApplications([activity])

    expect(applications.get(activity.key)?.[0]?.url).toBe('https://localhost:5173')
  })

  it('does not create a Web Application for non-HTML or unreachable listeners', async () => {
    const probeWeb = vi.fn(async () => false)
    configureTerminalWebApplicationDiscoveryForTests({ listListeners: async () => listenerOutput(), probeWeb })

    expect(await discoverTerminalWebApplications([activity])).toEqual(new Map())
    expect(await discoverTerminalWebApplications([activity])).toEqual(new Map())
    expect(probeWeb).toHaveBeenCalledTimes(2)
  })
})
