/**
 * Extension file-picker filter regression tests.
 *
 * A compiled native extension entry point (cos2's `main`) has no file
 * extension, so it matches only the '*' filter. macOS greys out everything
 * the ACTIVE filter rejects and defaults to the FIRST filter entry — with
 * the script filter first, native binaries were unselectable until the user
 * discovered the filter dropdown. The permissive filter must come first.
 *
 * Handlers are captured from a mocked ipcMain and invoked directly; the
 * dialog mock records the options it was shown.
 */
import { describe, it, expect, vi } from 'vitest'

const { handlers, showOpenDialogMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogMock: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({
  state: { mainWindow: { hide: vi.fn(), show: vi.fn() } },
}))
vi.mock('../../window-manager', () => ({ showWindow: vi.fn() }))
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

async function invokeExtensionPicker(): Promise<void> {
  const handler = handlers.get(IPC.SELECT_EXTENSION_FILES)
  if (!handler) throw new Error('no handler for SELECT_EXTENSION_FILES')
  await handler({ sender: {} })
}

type DialogFilter = { name: string; extensions: string[] }

function shownFilters(): DialogFilter[] {
  const call = showOpenDialogMock.mock.calls.at(-1)
  if (!call) throw new Error('showOpenDialog never called')
  // Darwin passes options as the sole argument; other platforms prefix the
  // window. The options object is whichever argument carries `filters`.
  const options = (call as unknown[]).find(
    (arg) => typeof arg === 'object' && arg !== null && 'filters' in arg,
  ) as { filters: DialogFilter[] }
  return options.filters
}

describe('SELECT_EXTENSION_FILES picker filters', () => {
  it('leads with a permissive filter so extensionless native binaries are selectable', async () => {
    await invokeExtensionPicker()
    const filters = shownFilters()
    // The FIRST filter is the active default on macOS; it must accept
    // everything, or a compiled `main` binary is greyed out on open.
    expect(filters[0].extensions).toEqual(['*'])
  })

  it('still offers the script filter as an optional narrowing', async () => {
    await invokeExtensionPicker()
    const filters = shownFilters()
    const script = filters.find((f) => f.extensions.includes('ts'))
    expect(script).toBeDefined()
    expect(script!.extensions).toEqual(['ts', 'js', 'mjs', 'cjs'])
  })
})
