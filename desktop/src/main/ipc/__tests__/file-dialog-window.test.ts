/**
 * Wrong-window hide regression (SELECT_DIRECTORY + SELECT_EXTENSION_FILES).
 *
 * Both handlers used to hide state.mainWindow (the overlay) regardless of
 * which window invoked them: a picker opened from the Studio window made
 * the OVERLAY vanish and parented the dialog to nothing. The fix derives
 * the window from the invoking webContents and hides only when the sender
 * IS the overlay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, showOpenDialogMock, fromWebContentsMock, mainWindowMock, showWindowMock } = vi.hoisted(() => {
  const mainWindowMock = { hide: vi.fn(), show: vi.fn() }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    showOpenDialogMock: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    fromWebContentsMock: vi.fn(),
    mainWindowMock,
    showWindowMock: vi.fn(),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: fromWebContentsMock },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({
  state: { mainWindow: mainWindowMock },
}))
vi.mock('../../window-manager', () => ({ showWindow: showWindowMock }))
vi.mock('../../ipc-validation', () => ({
  validateExternalUrl: vi.fn(() => true),
  isValidProjectPath: vi.fn(() => true),
}))
vi.mock('../../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(async () => false),
  getEngineHostInfo: vi.fn(async () => ({})),
  listEngineDirectory: vi.fn(async () => []),
  getEnterprisePolicyNewConversationDefaults: vi.fn(async () => null),
  getEnterprisePolicy: vi.fn(async () => null),
}))

import { registerFileDialogIpc } from '../file-dialog'
import { IPC } from '../../../shared/types'

registerFileDialogIpc()

async function invoke(channel: string): Promise<void> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  await handler({ sender: {} })
}

beforeEach(() => {
  mainWindowMock.hide.mockClear()
  mainWindowMock.show.mockClear()
  showWindowMock.mockClear()
  fromWebContentsMock.mockReset()
})

describe('file-dialog wrong-window hide', () => {
  for (const channel of [IPC.SELECT_DIRECTORY, IPC.SELECT_EXTENSION_FILES]) {
    it(`${channel}: overlay sender hides and restores the overlay`, async () => {
      fromWebContentsMock.mockReturnValue(mainWindowMock) // sender IS the overlay
      await invoke(channel)
      expect(mainWindowMock.hide).toHaveBeenCalledTimes(1)
      // Restored via showWindow (SELECT_DIRECTORY) or mainWindow.show
      // (SELECT_EXTENSION_FILES) — either restore path counts.
      expect(showWindowMock.mock.calls.length + mainWindowMock.show.mock.calls.length).toBe(1)
    })

    it(`${channel}: studio sender never touches the overlay`, async () => {
      fromWebContentsMock.mockReturnValue({ hide: vi.fn(), show: vi.fn() }) // some other window
      await invoke(channel)
      expect(mainWindowMock.hide).not.toHaveBeenCalled()
      expect(mainWindowMock.show).not.toHaveBeenCalled()
      expect(showWindowMock).not.toHaveBeenCalled()
    })
  }
})
