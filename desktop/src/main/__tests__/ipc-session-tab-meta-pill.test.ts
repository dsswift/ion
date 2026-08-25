/**
 * IPC.TAB_META_CHANGED handler — pillColor / pillIcon forwarding.
 *
 * Pins that the main-process TAB_META_CHANGED listener (registerSessionIpc in
 * ipc/session.ts) forwards pillColor and pillIcon onto the desktop_tab_meta
 * wire delta it sends over remoteTransport, including the null-clears-it case.
 * Absent fields must not appear on the delta at all (so a rename push
 * doesn't accidentally clear an existing pill customization on iOS).
 *
 * Failure mode without the fix: the handler destructured only
 * { tabId, title, runCostUsd, totalCostUsd, groupId } from the payload, so
 * pillColor/pillIcon sent from the renderer's setTabPillColor/setTabPillIcon
 * push were silently dropped and iOS never learned of pill changes via the
 * event-driven path (only the 5 s snapshot poll would eventually carry them).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    },
  },
}))

const mocks = vi.hoisted(() => ({
  remoteSend: vi.fn(),
}))

vi.mock('../state', () => ({
  state: {
    remoteTransport: { send: mocks.remoteSend },
    mainWindow: null,
  },
  sessionPlane: {
    hasTab: vi.fn().mockReturnValue(true),
    ensureTab: vi.fn(),
    initSession: vi.fn(),
    resetTabSession: vi.fn(),
    restartTabSession: vi.fn(),
    cancel: vi.fn(),
    cancelTab: vi.fn(),
    retry: vi.fn(),
    getHealth: vi.fn(),
    closeTab: vi.fn(),
    ensureSession: vi.fn(),
    relocateSession: vi.fn(),
    adoptTab: vi.fn(),
    createTab: vi.fn(),
  },
  engineBridge: { stopByPrefix: vi.fn(), stopSession: vi.fn(), sendSteer: vi.fn() },
  activeAssistantMessages: { delete: vi.fn() },
  lastMessagePreview: { delete: vi.fn() },
  lastForwardedTabStatus: { delete: vi.fn() },
  lastForwardedTabMeta: { delete: vi.fn() },
  extensionCommandRegistry: { keys: () => [] },
  DEBUG_MODE: false,
}))

vi.mock('../terminal-manager-instance', () => ({
  terminalManager: { destroyByPrefix: vi.fn() },
}))

vi.mock('../remote/snapshot', () => ({
  getRemoteTabStates: vi.fn(),
}))

vi.mock('../studio-state-cache', () => ({
  evictStudioTab: vi.fn(),
}))

vi.mock('../studio-window-manager', () => ({
  notifyStudioUserMessageEcho: vi.fn(),
}))

vi.mock('../prompt-pipeline', () => ({
  processIncomingPrompt: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../ipc-validation', () => ({
  isValidProjectPath: vi.fn(() => true),
}))

vi.mock('../slash-parse', () => ({
  parseSlash: vi.fn(() => null),
}))

vi.mock('../automation/runtime', () => ({
  getAutomationRuntime: () => ({ trigger: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  setSessionContext: vi.fn(),
}))

import { registerSessionIpc } from '../ipc/session'

beforeEach(() => {
  handlers.clear()
  mocks.remoteSend.mockReset()
  registerSessionIpc()
})

describe('IPC.TAB_META_CHANGED handler — pill fields', () => {
  it('forwards pillColor onto the desktop_tab_meta delta', () => {
    const handler = handlers.get('ion:tab-meta-changed')
    expect(handler).toBeDefined()
    handler!(null, { tabId: 'tab-1', pillColor: '#f08c4a' })
    expect(mocks.remoteSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop_tab_meta', tabId: 'tab-1', pillColor: '#f08c4a' }),
    )
  })

  it('forwards pillIcon onto the desktop_tab_meta delta', () => {
    const handler = handlers.get('ion:tab-meta-changed')
    handler!(null, { tabId: 'tab-1', pillIcon: 'diamond' })
    expect(mocks.remoteSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop_tab_meta', tabId: 'tab-1', pillIcon: 'diamond' }),
    )
  })

  it('forwards a null pillColor as an explicit clear, not an omission', () => {
    const handler = handlers.get('ion:tab-meta-changed')
    handler!(null, { tabId: 'tab-1', pillColor: null })
    const sent = mocks.remoteSend.mock.calls[0][0]
    expect('pillColor' in sent).toBe(true)
    expect(sent.pillColor).toBeNull()
  })

  it('forwards a null pillIcon as an explicit clear, not an omission', () => {
    const handler = handlers.get('ion:tab-meta-changed')
    handler!(null, { tabId: 'tab-1', pillIcon: null })
    const sent = mocks.remoteSend.mock.calls[0][0]
    expect('pillIcon' in sent).toBe(true)
    expect(sent.pillIcon).toBeNull()
  })

  it('omits pillColor/pillIcon from the delta when absent (e.g. a title-only change)', () => {
    const handler = handlers.get('ion:tab-meta-changed')
    handler!(null, { tabId: 'tab-1', title: 'Renamed' })
    const sent = mocks.remoteSend.mock.calls[0][0]
    expect('pillColor' in sent).toBe(false)
    expect('pillIcon' in sent).toBe(false)
  })
})
