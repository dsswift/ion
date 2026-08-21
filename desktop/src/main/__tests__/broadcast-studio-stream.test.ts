/**
 * Full-stream gate to the Studio window (mirror-store architecture): while the
 * Studio window is open it receives EVERY normalized event (text deltas
 * included) plus tab-status/enriched-error pushes; the main-process Studio
 * cache still ingests only the canvas subset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { updateStudioCacheMock } = vi.hoisted(() => ({ updateStudioCacheMock: vi.fn() }))
vi.mock('../studio-state-cache', async (importOriginal) => {
  const real = await importOriginal<typeof import('../studio-state-cache')>()
  return { ...real, updateStudioCache: updateStudioCacheMock }
})
vi.mock('../studio-beacon', () => ({ maybeBeacon: vi.fn() }))
vi.mock('../state', () => ({
  state: {
    mainWindow: null,
    studioWindow: null,
    remoteTransport: null,
    terminalOutputFlushTimer: null,
  },
  terminalOutputAccumulator: new Map(),
  terminalScrollback: new Map(),
  MAX_SCROLLBACK_SIZE: 1024,
}))

import { IPC } from '../../shared/types'
import { broadcast } from '../broadcast'
import { state } from '../state'

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as NonNullable<typeof state.studioWindow>
}

beforeEach(() => {
  updateStudioCacheMock.mockClear()
  ;(state as { studioWindow: unknown }).studioWindow = null
})

describe('broadcast → Studio full-stream gate', () => {
  it('forwards text deltas (non-canvas events) to an open Studio window', () => {
    const win = fakeWindow()
    ;(state as { studioWindow: unknown }).studioWindow = win
    broadcast('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })
    expect(win.webContents.send).toHaveBeenCalledWith('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })
    // The canvas cache ignores non-subset events.
    expect(updateStudioCacheMock).not.toHaveBeenCalled()
  })

  it('caches canvas-subset events regardless of window state', () => {
    broadcast('ion:normalized-event', 'tab-1', { type: 'agent_state', agents: [] })
    expect(updateStudioCacheMock).toHaveBeenCalledTimes(1)
  })

  it('forwards tab-status and enriched-error pushes to the open Studio window', () => {
    const win = fakeWindow()
    ;(state as { studioWindow: unknown }).studioWindow = win
    broadcast('ion:tab-status-change', 'tab-1', 'running', 'idle')
    broadcast('ion:enriched-error', 'tab-1', { message: 'x' })
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('forwards engine-reconnected to the open Studio window so the mirror re-arms failed hydration', () => {
    const win = fakeWindow()
    ;(state as { studioWindow: unknown }).studioWindow = win
    broadcast('ion:engine-reconnected')
    expect(win.webContents.send).toHaveBeenCalledWith('ion:engine-reconnected')
  })

  it('forwards deep-link confirmation requests and settlements to open Studio window', () => {
    const win = fakeWindow()
    ;(state as { studioWindow: unknown }).studioWindow = win
    broadcast(IPC.DEEPLINK_CONFIRM_REQUEST, { id: 'dl-1', owner: 'studio', action: 'terminal' })
    broadcast(IPC.DEEPLINK_CONFIRM_SETTLED, 'dl-1')

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC.DEEPLINK_CONFIRM_REQUEST,
      expect.objectContaining({ id: 'dl-1', owner: 'studio' }),
    )
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.DEEPLINK_CONFIRM_SETTLED, 'dl-1')
  })

  it('drops nothing into the void: closed Studio window means no send, no throw', () => {
    expect(() => broadcast('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })).not.toThrow()
    expect(() => broadcast('ion:tab-status-change', 'tab-1', 'running', 'idle')).not.toThrow()
  })
})
