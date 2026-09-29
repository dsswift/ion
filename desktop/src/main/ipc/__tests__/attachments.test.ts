import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'

const { handlers, warn, state, readFileSync } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  warn: vi.fn(),
  state: {
    studioWindow: { hide: vi.fn(), show: vi.fn(), isDestroyed: vi.fn(() => false), webContents: { focus: vi.fn() } },
    screenshotCounter: 0,
  },
  readFileSync: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readFileSync: (...args: unknown[]) => readFileSync(...(args as [])),
  statSync: vi.fn(() => ({ size: 8 })),
  writeFileSync: vi.fn(),
}))
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: vi.fn(() => { throw new Error('capture unavailable') }),
}))
vi.mock('../../state', () => ({ state, SPACES_DEBUG: false }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../window-manager', () => ({ showWindow: vi.fn(), snapshotWindowState: vi.fn() }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn, debug: vi.fn() }))

import { registerAttachmentsIpc, userImagesDir } from '../attachments'
import { IPC } from '@ion/shared/types'

registerAttachmentsIpc()

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`no handler for ${channel}`)
  return registered as (...args: unknown[]) => Promise<unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  state.screenshotCounter = 0
})

describe('attachment IPC failures', () => {
  it('logs screenshot capture failure before returning null and restores window', async () => {
    await expect(handler(IPC.TAKE_SCREENSHOT)({})).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('main', 'attachments: screenshot capture failed', { error: 'Error: capture unavailable' })
    expect(state.studioWindow.show).toHaveBeenCalled()
    expect(state.studioWindow.webContents.focus).toHaveBeenCalled()
  })

  it('stores screenshots under the data folder, not a hardcoded home path', () => {
    const previous = process.env.ION_DATA_DIR
    process.env.ION_DATA_DIR = '/srv/ion-data'
    try {
      expect(userImagesDir()).toBe(join('/srv/ion-data', 'user-images'))
    } finally {
      if (previous === undefined) delete process.env.ION_DATA_DIR
      else process.env.ION_DATA_DIR = previous
    }
  })
})
