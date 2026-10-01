import { describe, expect, it } from 'vitest'
import type { TerminalActivity } from '@ion/shared/terminal-activity'
import { describePortListeners } from '../listeners'

const activity: TerminalActivity = {
  key: 'tab-1:t1', tabId: 'tab-1', instanceId: 't1', active: true, processLabel: 'npm', processIds: [100, 101],
  applications: [{ id: 'native:101:5173', kind: 'web', url: 'http://localhost:5173', port: 5173, pid: 101, processName: 'node', source: 'native' }],
}

describe('describePortListeners', () => {
  it('reports every listener, lowest port first, one row per port', () => {
    const rows = describePortListeners(
      [
        { pid: 900, host: '*', port: 8080, processName: 'java' },
        { pid: 101, host: '127.0.0.1', port: 5173, processName: 'node' },
        { pid: 101, host: '[::1]', port: 5173, processName: 'node' },
      ],
      [activity],
      () => true,
    )
    expect(rows.map((r) => r.port)).toEqual([5173, 8080])
  })

  it('names the owning conversation and the confirmed web URL', () => {
    const [row] = describePortListeners([{ pid: 101, host: '127.0.0.1', port: 5173, processName: 'node' }], [activity], () => true)
    expect(row).toEqual({ port: 5173, pid: 101, processName: 'node', tabId: 'tab-1', url: 'http://localhost:5173' })
  })

  it('reports a listener no Terminal owns, with no conversation', () => {
    const rows = describePortListeners([{ pid: 900, host: '*', port: 8080, processName: 'java' }], [activity], () => true)
    expect(rows.find((r) => r.port === 8080)).toEqual({ port: 8080, pid: 900, processName: 'java', tabId: null, url: null })
  })

  it('withholds a conversation the caller may not be told about, and still reports the port', () => {
    const [row] = describePortListeners([{ pid: 101, host: '127.0.0.1', port: 5173, processName: 'node' }], [activity], () => false)
    expect(row.port).toBe(5173)
    expect(row.tabId).toBeNull()
  })

  it('reports a confirmed web application that has no listener row of its own', () => {
    const container: TerminalActivity = {
      ...activity,
      processIds: [200],
      applications: [{ id: 'container:3000', kind: 'web', url: 'http://localhost:3000', port: 3000, pid: null, processName: 'docker', source: 'container' }],
    }
    expect(describePortListeners([], [container], () => true)).toEqual([{ port: 3000, pid: null, processName: null, tabId: 'tab-1', url: 'http://localhost:3000' }])
  })
})
