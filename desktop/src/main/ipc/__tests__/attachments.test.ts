import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, warn, state, readFileSync } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  warn: vi.fn(),
  state: {
    mainWindow: { hide: vi.fn(), show: vi.fn(), webContents: { focus: vi.fn() } },
    screenshotCounter: 0,
    pasteCounter: 0,
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

import { registerAttachmentsIpc } from '../attachments'
import { IPC } from '../../../shared/types'

registerAttachmentsIpc()

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`no handler for ${channel}`)
  return registered as (...args: unknown[]) => Promise<unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  state.screenshotCounter = 0
  state.pasteCounter = 0
})

describe('attachment IPC failures', () => {
  it('logs malformed pasted image input before rejecting it', async () => {
    await expect(handler(IPC.PASTE_IMAGE)({}, 'not-a-data-url')).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('main', 'attachments: paste image rejected invalid data URL', {
      length: 14,
      mime: 'invalid',
    })
  })

  it('accepts SVG pasted image data URLs', async () => {
    const result = await handler(IPC.PASTE_IMAGE)({}, 'data:image/svg+xml;base64,PHN2Zy8+') as { mimeType: string; name: string }
    expect(result.mimeType).toBe('image/svg+xml')
    expect(result.name).toBe('pasted image 1.svg')
  })

  it('logs screenshot capture failure before returning null and restores window', async () => {
    await expect(handler(IPC.TAKE_SCREENSHOT)({})).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('main', 'attachments: screenshot capture failed', { error: 'Error: capture unavailable' })
    expect(state.mainWindow.show).toHaveBeenCalled()
    expect(state.mainWindow.webContents.focus).toHaveBeenCalled()
  })

  it('rejects non-image or malformed pasted values before they can throw', async () => {
    await expect(handler(IPC.PASTE_IMAGE)({}, null)).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('main', 'attachments: paste image rejected invalid data URL', {
      length: 0,
      mime: 'invalid',
    })
  })
})
