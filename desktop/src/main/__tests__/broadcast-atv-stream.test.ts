/**
 * Full-stream gate to the ATV window (mirror-store architecture): while the
 * ATV window is open it receives EVERY normalized event (text deltas
 * included) plus tab-status/enriched-error pushes; the main-process ATV
 * cache still ingests only the canvas subset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { updateAtvCacheMock } = vi.hoisted(() => ({ updateAtvCacheMock: vi.fn() }))
vi.mock('../atv-state-cache', async (importOriginal) => {
  const real = await importOriginal<typeof import('../atv-state-cache')>()
  return { ...real, updateAtvCache: updateAtvCacheMock }
})
vi.mock('../atv-beacon', () => ({ maybeBeacon: vi.fn() }))
vi.mock('../state', () => ({
  state: {
    mainWindow: null,
    atvWindow: null,
    remoteTransport: null,
    terminalOutputFlushTimer: null,
  },
  terminalOutputAccumulator: new Map(),
  terminalScrollback: new Map(),
  MAX_SCROLLBACK_SIZE: 1024,
}))

import { broadcast } from '../broadcast'
import { state } from '../state'

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as NonNullable<typeof state.atvWindow>
}

beforeEach(() => {
  updateAtvCacheMock.mockClear()
  ;(state as { atvWindow: unknown }).atvWindow = null
})

describe('broadcast → ATV full-stream gate', () => {
  it('forwards text deltas (non-canvas events) to an open ATV window', () => {
    const win = fakeWindow()
    ;(state as { atvWindow: unknown }).atvWindow = win
    broadcast('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })
    expect(win.webContents.send).toHaveBeenCalledWith('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })
    // The canvas cache ignores non-subset events.
    expect(updateAtvCacheMock).not.toHaveBeenCalled()
  })

  it('caches canvas-subset events regardless of window state', () => {
    broadcast('ion:normalized-event', 'tab-1', { type: 'agent_state', agents: [] })
    expect(updateAtvCacheMock).toHaveBeenCalledTimes(1)
  })

  it('forwards tab-status and enriched-error pushes to the open ATV window', () => {
    const win = fakeWindow()
    ;(state as { atvWindow: unknown }).atvWindow = win
    broadcast('ion:tab-status-change', 'tab-1', 'running', 'idle')
    broadcast('ion:enriched-error', 'tab-1', { message: 'x' })
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('drops nothing into the void: closed ATV window means no send, no throw', () => {
    expect(() => broadcast('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })).not.toThrow()
    expect(() => broadcast('ion:tab-status-change', 'tab-1', 'running', 'idle')).not.toThrow()
  })
})
