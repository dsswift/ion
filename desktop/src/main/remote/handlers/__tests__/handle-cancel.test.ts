/**
 * handleCancel — unified interrupt parity (iOS abort fix)
 *
 * `desktop_cancel` (sent by iOS when the user taps the stop button) must behave
 * like the desktop renderer's `interrupt`: abort the parent run AND reap the
 * dispatched-agent subtree. handleCancel delegates to sessionPlane.cancelTab,
 * which performs both; when the tab is NOT tracked by the session plane it falls
 * back to firing both on engineBridge directly.
 *
 * Coverage:
 *   1. Tracked tab: cancelTab returns true, no direct bridge calls from the
 *      fallback branch.
 *   2. Untracked tab: cancelTab returns false → fallback fires BOTH
 *      engineBridge.sendAbort AND engineBridge.sendAbortAgent(tabId, '', true).
 *      Removing the reap line on the fallback path makes assertion (2b) fail —
 *      that is the regression guard for the not-in-plane case.
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
const sendAbortAgentMock = vi.fn()

vi.mock('../../../state', () => ({
  state: {},
  sessionPlane: {
    cancelTab: (tabId: string) => cancelTabMock(tabId),
  },
  engineBridge: {
    sendAbort: (tabId: string) => sendAbortMock(tabId),
    sendAbortAgent: (tabId: string, agentName: string, subtree: boolean) =>
      sendAbortAgentMock(tabId, agentName, subtree),
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

    expect(cancelTabMock).toHaveBeenCalledWith('tab-1')
    // cancelTab handled it (it performs abort + reap internally); the fallback
    // branch must not double-fire on the bridge.
    expect(sendAbortMock).not.toHaveBeenCalled()
    expect(sendAbortAgentMock).not.toHaveBeenCalled()
  })

  it('falls back to abort AND subtree reap when the tab is not in the session plane', () => {
    cancelTabMock.mockReturnValue(false)

    handleCancel({ type: 'desktop_cancel', tabId: 'tab-2' })

    expect(cancelTabMock).toHaveBeenCalledWith('tab-2')
    // (2a) parent run aborted directly
    expect(sendAbortMock).toHaveBeenCalledWith('tab-2')
    // (2b) dispatched-agent subtree reaped directly — empty agentName + subtree
    // reaps all descendants; removing this line in handleCancel fails this test.
    expect(sendAbortAgentMock).toHaveBeenCalledWith('tab-2', '', true)
  })
})
