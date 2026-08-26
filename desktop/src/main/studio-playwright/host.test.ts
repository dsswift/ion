import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const appMock = vi.hoisted(() => ({
  commandLine: { appendSwitch: vi.fn() },
  getPath: vi.fn(() => '/tmp/ion-test'),
}))
vi.mock('electron', () => ({ app: appMock }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { StudioPlaywrightHost, readDevToolsEndpoint } from './host'

function webContents(id: number) {
  let destroyed = false
  let onDestroyed: (() => void) | undefined
  return {
    id,
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({ targetInfo: { targetId: `target-${id}` } })),
    },
    isDestroyed: () => destroyed,
    once: vi.fn((_event: string, callback: () => void) => { onDestroyed = callback }),
    destroy: () => { destroyed = true; onDestroyed?.() },
  }
}

describe('StudioPlaywrightHost', () => {
  it('accepts only a registered conversation and browser instance pair', async () => {
    const host = new StudioPlaywrightHost()
    const guest = webContents(12)
    host.register('conversation-1', 'browser-1', guest as never)

    await vi.waitFor(() => {
      expect(host.resolve('conversation-1', 'browser-1')?.cdpTargetId).toBe('target-12')
    })
    expect(host.resolve('conversation-1', 'other-browser')).toBeNull()
    expect(host.resolve('../conversation', 'browser-1')).toBeNull()

    guest.destroy()
    expect(host.resolve('conversation-1', 'browser-1')).toBeNull()
  })

  it('uses Chromium DevToolsActivePort instead of a fixed port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ion-devtools-'))
    const path = join(dir, 'DevToolsActivePort')
    await writeFile(path, '41723\n/devtools/browser/example\n')
    await expect(readDevToolsEndpoint(path)).resolves.toBe('http://127.0.0.1:41723')
  })
})
