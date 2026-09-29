// @vitest-environment jsdom
/**
 * Which receivers `registerStudioGraphCommands` installs on each host, and
 * how the wire receiver answers.
 *
 * host-instance.ts caches its resolved host class for the module's
 * lifetime, so the host is mocked directly here (the sibling
 * studio-graph-commands.test.ts drives a real ElectronStudioHost through
 * window.ion and covers the command semantics against a real graph store).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const fake = vi.hoisted(() => {
  const listeners = new Set<(environmentId: string, frame: StudioFrame) => void>()
  return {
    listeners,
    sent: [] as Array<{ environmentId: string; frame: StudioFrame }>,
    capabilities: vi.fn<() => string[]>(),
    deliver(environmentId: string, frame: StudioFrame): void {
      for (const l of [...listeners]) l(environmentId, frame)
    },
  }
})

vi.mock('../../host/host-instance', () => ({
  host: {
    capabilities: fake.capabilities,
    shell: {},
    onFrame: (cb: (environmentId: string, frame: StudioFrame) => void) => { fake.listeners.add(cb); return () => fake.listeners.delete(cb) },
    send: (environmentId: string, frame: StudioFrame) => { fake.sent.push({ environmentId, frame }) },
  },
}))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn() }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ tabs: [], activeTabId: null }) } }))
vi.mock('../surface/surface-store', () => ({ useSurfaceStore: { getState: () => ({ currentConversationId: null }) } }))

import { registerStudioGraphCommands } from './studio-graph-commands'

const BROWSER_CAPS = ['terminal', 'git', 'files', 'questions', 'graph']

beforeEach(() => {
  fake.listeners.clear()
  fake.sent.length = 0
})

describe('registerStudioGraphCommands', () => {
  it('listens on the wire on a browser Studio client', () => {
    fake.capabilities.mockReturnValue(BROWSER_CAPS)
    const stop = registerStudioGraphCommands()
    expect(fake.listeners.size).toBe(1)
    stop()
    expect(fake.listeners.size).toBe(0)
  })

  it('listens on the same wire on the Electron window', () => {
    fake.capabilities.mockReturnValue(['nativeShell'])
    registerStudioGraphCommands()
    expect(fake.listeners.size).toBe(1)
  })
})

describe('the wire receiver', () => {
  beforeEach(() => {
    fake.capabilities.mockReturnValue(BROWSER_CAPS)
    registerStudioGraphCommands()
  })

  it('ignores commands outside the graph family', () => {
    fake.deliver('env-1', { type: 'studio_command', id: 'c1', command: 'browser.click', args: {}, timeoutMs: 1000 })
    expect(fake.sent).toEqual([])
  })

  it('answers a malformed graph command as a refusal, to the Environment that sent it', () => {
    fake.deliver('env-2', { type: 'studio_command', id: 'c2', command: 'graph.state', args: { kind: 'state' }, timeoutMs: 1000 })
    expect(fake.sent).toHaveLength(1)
    const { environmentId, frame } = fake.sent[0]!
    expect(environmentId).toBe('env-2')
    expect(frame.type).toBe('studio_command_result')
    if (frame.type !== 'studio_command_result') return
    expect(frame.id).toBe('c2')
    expect(frame.ok).toBe(true)
    expect(frame.value).toMatchObject({ callId: 'c2', ok: false, error: expect.stringContaining('malformed') })
  })

  it('answers a well-formed command for a graph that is not open with the tool-visible refusal', async () => {
    fake.deliver('env-3', {
      type: 'studio_command', id: 'c3', command: 'graph.state',
      args: { kind: 'state', conversationId: 'tab-1', cwd: '/root' }, timeoutMs: 1000,
    })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    const { environmentId, frame } = fake.sent[0]!
    expect(environmentId).toBe('env-3')
    if (frame.type !== 'studio_command_result') throw new Error('expected a studio_command_result')
    expect(frame.id).toBe('c3')
    expect(frame.value).toMatchObject({ callId: 'c3', ok: false, error: expect.stringContaining('graph_open') })
  })
})
