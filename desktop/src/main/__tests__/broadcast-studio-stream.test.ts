/**
 * The main process's `broadcast()` to its own windows: startup progress to
 * the splash and the updater's lifecycle signals to the Studio window reach
 * an open window and are dropped without a throw when the window is closed.
 *
 * Everything else is deliberately absent. The engine-event stream, terminal
 * output, deep-link confirmations, resource and questions state, settings
 * and theme changes, the device transport's relay and display changes: the
 * Studio server owns every one of those producers (ADR-033) and fans them
 * out as studio_event frames, which reach the window through
 * `ipc/studio-bridge.ts`. A forwarding branch here for any of them would
 * keep a dead path green while the window read the server's frames.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { state } from '../state'

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as NonNullable<typeof state.studioWindow>
}

beforeEach(() => {
  state.studioWindow = null
  state.splashWindow = null
})

describe('broadcast → window pushes', () => {
  it('forwards updater lifecycle signals to an open Studio window', () => {
    const win = fakeWindow()
    state.studioWindow = win
    broadcast(IPC.UPDATE_DOWNLOADED, { version: '1.2.3' })
    broadcast(IPC.UPDATE_PROGRESS, { percent: 50 })
    broadcast(IPC.UPDATE_STAGED)
    broadcast(IPC.UPDATE_ERROR, { message: 'x' })
    expect((win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([IPC.UPDATE_DOWNLOADED, IPC.UPDATE_PROGRESS, IPC.UPDATE_STAGED, IPC.UPDATE_ERROR])
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.UPDATE_DOWNLOADED, { version: '1.2.3' })
  })

  it('routes startup progress to the splash, never the Studio window', () => {
    const splash = fakeWindow()
    const studio = fakeWindow()
    state.splashWindow = splash
    state.studioWindow = studio
    broadcast(IPC.STARTUP_STATE, 'engine-ready')
    expect(splash.webContents.send).toHaveBeenCalledWith(IPC.STARTUP_STATE, 'engine-ready')
    expect(studio.webContents.send).not.toHaveBeenCalled()
  })

  it('does not forward server-owned channels: no producer in this process, the window reads server frames', () => {
    const win = fakeWindow()
    state.studioWindow = win
    broadcast('ion:normalized-event', 'tab-1', { type: 'text_chunk', text: 'hi' })
    broadcast('ion:tab-status-change', 'tab-1', 'running', 'idle')
    broadcast(IPC.DEEPLINK_CONFIRM_REQUEST, { id: 'dl-1', owner: 'studio', action: 'terminal' })
    broadcast(IPC.STUDIO_CONVERSATION_TERMINALS, { revision: 1, panes: [], openTabIds: [] })
    broadcast(IPC.CHART_JUMP, { tabId: 't', chartId: 'c', messageId: 'm' })
    broadcast(IPC.RESOURCE_CATALOG_CHANGED)
    broadcast(IPC.TERMINAL_INCOMING, 'tab1:i1', 'ls\n')
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('drops nothing into the void: a closed window means no send, no throw', () => {
    expect(() => broadcast(IPC.UPDATE_DOWNLOADED, { version: '1.2.3' })).not.toThrow()
    expect(() => broadcast(IPC.STARTUP_STATE, 'engine-ready')).not.toThrow()
  })
})
