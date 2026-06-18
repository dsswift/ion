/**
 * EngineBridge.remapSession — unit tests
 *
 * Tests the key-alias mechanism on EngineBridge directly, without opening a
 * socket. The constructor does not connect, so `new EngineBridge()` is safe.
 * Private fields are accessed via bracket notation where needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock filesystem and child_process — these are imported at module load
// even though they're only used in connect/start paths.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ''),
}))
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { EngineBridge } from '../engine-bridge'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBridge() {
  const bridge = new EngineBridge()
  const events: Array<{ key: string; event: any }> = []
  bridge.on('event', (key: string, event: any) => events.push({ key, event }))
  return { bridge, events }
}

function injectMessage(bridge: EngineBridge, key: string, type = 'desktop_text_chunk') {
  const line = JSON.stringify({ key, event: { type, text: 'hello' } })
  ;(bridge as any)['_handleMessage'](line)
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('EngineBridge.remapSession', () => {
  it('moves activeSessions entry from oldKey to newKey', () => {
    const { bridge } = makeBridge()
    const activeSessions: Map<string, any> = (bridge as any)['activeSessions']
    activeSessions.set('A:i1', { config: { profileId: 'p1', extensions: [], workingDirectory: '/tmp' } })

    bridge.remapSession('A:i1', 'B:i1')

    expect(activeSessions.has('B:i1')).toBe(true)
    expect(activeSessions.has('A:i1')).toBe(false)
    expect(activeSessions.get('B:i1')!.config.profileId).toBe('p1')
  })

  it('rewrites incoming event key via alias', () => {
    const { bridge, events } = makeBridge()
    bridge.remapSession('A:i1', 'B:i1')
    injectMessage(bridge, 'A:i1')

    expect(events).toHaveLength(1)
    expect(events[0].key).toBe('B:i1')
  })

  it('passes through events for unaliased keys unchanged', () => {
    const { bridge, events } = makeBridge()
    injectMessage(bridge, 'C:i1')

    expect(events).toHaveLength(1)
    expect(events[0].key).toBe('C:i1')
  })

  it('chained remap (A→B then B→C) routes A events to C', () => {
    const { bridge, events } = makeBridge()
    bridge.remapSession('A:i1', 'B:i1')
    bridge.remapSession('B:i1', 'C:i1')

    injectMessage(bridge, 'A:i1')

    expect(events).toHaveLength(1)
    expect(events[0].key).toBe('C:i1')
  })

  it('chained remap routes B events to C after second remap', () => {
    const { bridge, events } = makeBridge()
    bridge.remapSession('A:i1', 'B:i1')
    bridge.remapSession('B:i1', 'C:i1')

    injectMessage(bridge, 'B:i1')

    expect(events).toHaveLength(1)
    expect(events[0].key).toBe('C:i1')
  })

  it('is a no-op for activeSessions when key is unknown but alias still installs', () => {
    const { bridge, events } = makeBridge()
    const activeSessions: Map<string, any> = (bridge as any)['activeSessions']

    bridge.remapSession('X:i1', 'Y:i1')

    // activeSessions unchanged (no entry to move)
    expect(activeSessions.size).toBe(0)

    // But events keyed by X are rewritten to Y
    injectMessage(bridge, 'X:i1')
    expect(events[0].key).toBe('Y:i1')
  })

  it('preserves event payload through alias rewrite', () => {
    const { bridge, events } = makeBridge()
    bridge.remapSession('OLD:i1', 'NEW:i1')

    const line = JSON.stringify({ key: 'OLD:i1', event: { type: 'desktop_status', fields: { label: 'my-label' } } })
    ;(bridge as any)['_handleMessage'](line)

    expect(events[0].event.fields.label).toBe('my-label')
  })

  it('ignores unparseable lines without throwing', () => {
    const { bridge } = makeBridge()
    expect(() => {
      ;(bridge as any)['_handleMessage']('not json at all {{')
    }).not.toThrow()
  })

  it('remaps activeSessions preserving conversationId', () => {
    const { bridge } = makeBridge()
    const activeSessions: Map<string, any> = (bridge as any)['activeSessions']
    activeSessions.set('A:i2', {
      config: { profileId: 'p2', extensions: [], workingDirectory: '/home' },
      conversationId: 'conv-123',
    })

    bridge.remapSession('A:i2', 'B:i2')

    const entry = activeSessions.get('B:i2')
    expect(entry).toBeDefined()
    expect(entry.conversationId).toBe('conv-123')
  })
})
