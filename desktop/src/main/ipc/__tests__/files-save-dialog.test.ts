import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { IPC } from '@ion/shared/types'

const {
  handlers,
  showSaveDialog,
  fromWebContents,
  studioWindow,
  showWindow,
  log,
  warn,
  DOWNLOADS_DIR,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
  fromWebContents: vi.fn(),
  studioWindow: { hide: vi.fn() },
  showWindow: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  DOWNLOADS_DIR: '/Users/example/Downloads',
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => DOWNLOADS_DIR) },
  BrowserWindow: { fromWebContents },
  dialog: { showSaveDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
}))
vi.mock('../../state', () => ({
  fileWatchers: new Map(),
  recentlyWrittenPaths: new Set(),
}))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../window-manager', () => ({ showWindow }))
vi.mock('../../logger', () => ({ log, warn }))

import { registerFilesIpc } from '../files'

registerFilesIpc()

async function save(payload: { defaultPath?: unknown; defaultFileName?: unknown; filters?: unknown }): Promise<unknown> {
  const handler = handlers.get(IPC.FS_SAVE_DIALOG)
  if (!handler) throw new Error('save dialog handler not registered')
  return handler({ sender: {} }, payload)
}

describe('filesystem save dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  })

  it('opens from Studio with a Downloads filename, parented to the sender, with no hide/restore dance', async () => {
    // Studio is a normal window (unlike the deleted Overlay glass): the
    // native dialog renders on top of it with no hide/restore needed. See
    // ipc/file-dialog.ts's identical rationale and commit 4ca319fa8, which
    // removed this dance from ipc/files.ts.
    fromWebContents.mockReturnValue(studioWindow)

    await save({ defaultFileName: 'release-plan-20270305-0907.md' })

    expect(showSaveDialog).toHaveBeenCalledWith(studioWindow, {
      defaultPath: join(DOWNLOADS_DIR, 'release-plan-20270305-0907.md'),
    })
    expect(studioWindow.hide).not.toHaveBeenCalled()
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('passes a well-formed type filter to the dialog and refuses a malformed one', async () => {
    fromWebContents.mockReturnValue(studioWindow)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/x.zip' })

    await save({ defaultFileName: 'x.zip', filters: [{ name: 'Zip Archive', extensions: ['zip'] }] })
    expect(showSaveDialog).toHaveBeenCalledWith(studioWindow, {
      defaultPath: join(DOWNLOADS_DIR, 'x.zip'),
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
    })

    showSaveDialog.mockClear()
    const result = await save({ defaultFileName: 'x.zip', filters: [{ name: 'Any', extensions: ['*.zip'] }] })
    expect(result).toEqual({ filePath: null, error: 'Invalid filters' })
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('rejects a default filename that can escape Downloads', async () => {
    fromWebContents.mockReturnValue(studioWindow)

    const result = await save({ defaultFileName: '../plan.md' })

    expect(result).toEqual({ filePath: null, error: 'Invalid default filename' })
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})
