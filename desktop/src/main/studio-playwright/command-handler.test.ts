import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const bodies = vi.hoisted(() => ({
  execute: vi.fn(async (): Promise<{ content: string; isError: boolean }> => ({ content: 'done', isError: false })),
}))
vi.mock('./tools', () => ({
  studioBrowserToolBody: (name: string) => (name === 'browser_navigate' ? { name, execute: bodies.execute } : undefined),
}))
vi.mock('../connections/broker-instance', () => ({ broker: {} }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { installBrowserToolCommandHandler } from './command-handler'

function fakeBroker() {
  const listeners = new Set<(environmentId: string, frame: StudioFrame) => void>()
  const sent: Array<{ environmentId: string; frame: StudioFrame }> = []
  return {
    sent,
    onFrame(cb: (environmentId: string, frame: StudioFrame) => void) { listeners.add(cb); return () => listeners.delete(cb) },
    send(environmentId: string, frame: StudioFrame) { sent.push({ environmentId, frame }) },
    deliver(environmentId: string, frame: StudioFrame) { for (const l of [...listeners]) l(environmentId, frame) },
  }
}

const command = (id: string, args: unknown): StudioFrame => ({ type: 'studio_command', id, command: 'browser.tool', args, timeoutMs: 1000 })

beforeEach(() => { bodies.execute.mockClear() })

describe('browser.tool command handler', () => {
  it('runs the named body with the responder-supplied context and answers with the tool result', async () => {
    const broker = fakeBroker()
    installBrowserToolCommandHandler(broker)
    broker.deliver('local', command('c1', { name: 'browser_navigate', input: { url: 'https://x' }, ctx: { sessionKey: 'tab-1', cwd: '/repo', origin: 'extension' } }))
    await vi.waitFor(() => expect(broker.sent).toHaveLength(1))
    expect(bodies.execute).toHaveBeenCalledWith({ url: 'https://x' }, { sessionKey: 'tab-1', cwd: '/repo', origin: 'extension' })
    expect(broker.sent[0]).toEqual({ environmentId: 'local', frame: { type: 'studio_command_result', id: 'c1', ok: true, value: { content: 'done', isError: false } } })
  })

  it('defaults an unknown origin to model, the less privileged one', async () => {
    const broker = fakeBroker()
    installBrowserToolCommandHandler(broker)
    broker.deliver('local', command('c2', { name: 'browser_navigate', input: {}, ctx: { sessionKey: 'tab-1', cwd: '/repo', origin: 'root' } }))
    await vi.waitFor(() => expect(broker.sent).toHaveLength(1))
    expect(bodies.execute).toHaveBeenCalledWith({}, expect.objectContaining({ origin: 'model' }))
  })

  it('answers a tool with no body as a model-visible failure, not a timeout', async () => {
    const broker = fakeBroker()
    installBrowserToolCommandHandler(broker)
    broker.deliver('local', command('c3', { name: 'browser_teleport', input: {}, ctx: { sessionKey: 't', cwd: '/r' } }))
    expect(broker.sent[0]?.frame).toMatchObject({ type: 'studio_command_result', id: 'c3', ok: true, value: { isError: true } })
  })

  it('refuses malformed args and non-local environments at the frame level', () => {
    const broker = fakeBroker()
    installBrowserToolCommandHandler(broker)
    broker.deliver('local', command('c4', { name: 'browser_navigate' }))
    broker.deliver('grover', command('c5', { name: 'browser_navigate', input: {}, ctx: { sessionKey: 't', cwd: '/r' } }))
    expect(broker.sent.map((s) => [s.environmentId, (s.frame as { ok?: boolean }).ok])).toEqual([['local', false], ['grover', false]])
    expect(bodies.execute).not.toHaveBeenCalled()
  })

  it('ignores every other frame', () => {
    const broker = fakeBroker()
    installBrowserToolCommandHandler(broker)
    broker.deliver('local', { type: 'studio_command', id: 'g', command: 'graph.state', args: {}, timeoutMs: 1 })
    broker.deliver('local', { type: 'studio_event', channel: 'x', payload: null })
    expect(broker.sent).toEqual([])
  })
})
