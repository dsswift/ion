import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../../shared/types'

const {
  handlers,
  showSaveDialog,
  fromWebContents,
  overlayWindow,
  studioWindow,
  showWindow,
  log,
  warn,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
  fromWebContents: vi.fn(),
  overlayWindow: { hide: vi.fn() },
  studioWindow: { hide: vi.fn() },
  showWindow: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Users/example/Downloads') },
  BrowserWindow: { fromWebContents },
  dialog: { showSaveDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
}))
vi.mock('../../state', () => ({
  state: { mainWindow: overlayWindow },
  fileWatchers: new Map(),
  recentlyWrittenPaths: new Set(),
}))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../window-manager', () => ({ showWindow }))
vi.mock('../../logger', () => ({ log, warn }))

import { registerFilesIpc } from '../files'

registerFilesIpc()

async function save(payload: { defaultPath?: unknown; defaultFileName?: unknown }): Promise<unknown> {
  const handler = handlers.get(IPC.FS_SAVE_DIALOG)
  if (!handler) throw new Error('save dialog handler not registered')
  return handler({ sender: {} }, payload)
}

describe('filesystem save dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  })

  it('opens from Studio with a Downloads filename and leaves the overlay visible', async () => {
    fromWebContents.mockReturnValue(studioWindow)

    await save({ defaultFileName: 'release-plan-20270305-0907.md' })

    expect(showSaveDialog).toHaveBeenCalledWith(studioWindow, {
      defaultPath: '/Users/example/Downloads/release-plan-20270305-0907.md',
    })
    expect(overlayWindow.hide).not.toHaveBeenCalled()
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('hides and restores the overlay when the overlay opens the dialog', async () => {
    fromWebContents.mockReturnValue(overlayWindow)

    await save({ defaultPath: '/tmp/plan.md' })

    expect(overlayWindow.hide).toHaveBeenCalledTimes(1)
    expect(showSaveDialog).toHaveBeenCalledWith(overlayWindow, { defaultPath: '/tmp/plan.md' })
    expect(showWindow).toHaveBeenCalledWith('dialog-return')
  })

  it('rejects a default filename that can escape Downloads', async () => {
    fromWebContents.mockReturnValue(studioWindow)

    const result = await save({ defaultFileName: '../plan.md' })

    expect(result).toEqual({ filePath: null, error: 'Invalid default filename' })
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})
