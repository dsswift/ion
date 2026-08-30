import { describe, expect, it, vi, beforeEach } from 'vitest'
import { IPC } from '../../shared/types'

/**
 * Shared-surface channels must reach BOTH presentations.
 *
 * THE BUG THESE EXIST FOR: the Desktop is one client with two presentations,
 * and `broadcast()` sends to the Overlay window unconditionally but forwards
 * to the Studio window only for an explicit allowlist. `CHART_JUMP` was not on
 * it.
 *
 * When Studio is active the Overlay renderer is still alive but HIDDEN. So a
 * chart-jump request scrolled the Overlay's offscreen transcript and logged a
 * successful, converged jump — `attempts: 2`, settled — while the window the
 * operator was actually looking at never moved. Every layer reported success
 * and the visible surface did nothing, which is the most expensive shape a
 * defect can take.
 *
 * A channel that drives a surface mounted in both presentations belongs on the
 * allowlist. These tests pin the ones that do.
 */

const sends = {
  overlay: [] as string[],
  studio: [] as string[],
}

const windows = vi.hoisted(() => ({ studioOpen: true }))

vi.mock('../state', () => ({
  state: {
    get mainWindow() {
      return {
        isDestroyed: () => false,
        webContents: { send: (channel: string) => { sends.overlay.push(channel) } },
      }
    },
    get studioWindow() {
      return windows.studioOpen
        ? {
          isDestroyed: () => false,
          webContents: { send: (channel: string) => { sends.studio.push(channel) } },
        }
        : null
    },
    splashWindow: null,
    remoteTransport: null,
  },
  terminalOutputAccumulator: new Map(),
  terminalScrollback: new Map(),
  MAX_SCROLLBACK_SIZE: 1000,
}))
vi.mock('../studio-state-cache', () => ({ studioWantsEvent: () => false, updateStudioCache: vi.fn() }))
vi.mock('../studio-beacon', () => ({ maybeBeacon: vi.fn() }))

import { broadcast } from '../broadcast'

describe('broadcast — shared-surface fan-out', () => {
  beforeEach(() => {
    sends.overlay.length = 0
    sends.studio.length = 0
    windows.studioOpen = true
  })

  it('forwards a chart jump to Studio, whose transcript may be the visible one', () => {
    // The exact defect: this reached only the Overlay, which is hidden while
    // Studio is active, so the visible transcript never moved.
    broadcast(IPC.CHART_JUMP, { tabId: 't1', chartId: 'c1', messageId: 'm1' })

    expect(sends.overlay).toContain(IPC.CHART_JUMP)
    expect(sends.studio).toContain(IPC.CHART_JUMP)
  })

  it('forwards a resource-catalog change to Studio, which renders the same panel', () => {
    broadcast(IPC.RESOURCE_CATALOG_CHANGED)

    expect(sends.overlay).toContain(IPC.RESOURCE_CATALOG_CHANGED)
    expect(sends.studio).toContain(IPC.RESOURCE_CATALOG_CHANGED)
  })

  it('still reaches the Overlay when the Studio window is closed', () => {
    windows.studioOpen = false
    broadcast(IPC.CHART_JUMP, { tabId: 't1', chartId: 'c1', messageId: 'm1' })

    expect(sends.overlay).toContain(IPC.CHART_JUMP)
    expect(sends.studio).toHaveLength(0)
  })

  it('does not forward an Overlay-only channel to Studio', () => {
    // The allowlist is deliberate, not incidental: a channel that drives an
    // Overlay-only affordance must stay out of the Studio stream.
    broadcast(IPC.WINDOW_SHOWN)

    expect(sends.overlay).toContain(IPC.WINDOW_SHOWN)
    expect(sends.studio).not.toContain(IPC.WINDOW_SHOWN)
  })
})
