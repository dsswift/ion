/**
 * handleCancel — unified interrupt parity (iOS abort fix)
 *
 * `desktop_cancel` (sent by iOS when the user taps the stop button) must behave
 * like the desktop renderer's `interrupt`: abort at its requested scope. handleCancel delegates to sessionPlane.cancelTab;
 * when the tab is NOT tracked by the session plane it falls back to engineBridge.
 *
 * Coverage:
 *   1. Tracked tab: cancelTab returns true, no direct bridge calls from the
 *      fallback branch.
 *   2. Untracked tab: cancelTab returns false → fallback fires exact scoped abort.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Electron is not installed in CI (npm ci --ignore-scripts skips the binary
// download). Any module in the transitive import chain that does
// `import ... from 'electron'` at the top level will throw at load time
// without this stub. This test runs headless main-process logic only; no
// real Electron APIs are exercised.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

const cancelTabMock = vi.fn()
const sendAbortMock = vi.fn()

vi.mock('../../../state', () => ({
  state: {},
  sessionPlane: {
    cancelTab: (tabId: string, scope?: string) => cancelTabMock(tabId, scope),
  },
  engineBridge: {
    sendAbort: (tabId: string, scope?: string) => sendAbortMock(tabId, scope),
  },
}))

vi.mock('../../../logger', () => ({ log: vi.fn() }))
vi.mock('../../../prompt-pipeline', () => ({ processIncomingPrompt: vi.fn() }))
vi.mock('../attachment-encoder', () => ({ encodeAttachments: vi.fn() }))
vi.mock('./engine', () => ({ getVoiceSystemPrompt: vi.fn() }))

import { handleCancel } from '../tabs-prompt'

describe('handleCancel — unified interrupt parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to cancelTab and does not fire the direct fallback for a tracked tab', () => {
    cancelTabMock.mockReturnValue(true)

    handleCancel({ type: 'desktop_cancel', tabId: 'tab-1' })

    expect(cancelTabMock).toHaveBeenCalledWith('tab-1', 'all')
    // cancelTab handled it (it performs abort + reap internally); the fallback
    // branch must not double-fire on the bridge.
    expect(sendAbortMock).not.toHaveBeenCalled()
  })

  it('falls back to exact all-scope abort when tab is not in session plane', () => {
    cancelTabMock.mockReturnValue(false)

    handleCancel({ type: 'desktop_cancel', tabId: 'tab-2' })

    expect(cancelTabMock).toHaveBeenCalledWith('tab-2', 'all')
    // Engine abort(all) owns complete teardown, including every descendant.
    expect(sendAbortMock).toHaveBeenCalledWith('tab-2', 'all')
  })
})
