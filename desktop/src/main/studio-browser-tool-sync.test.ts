import { beforeEach, describe, expect, it, vi } from 'vitest'

const startSession = vi.hoisted(() => vi.fn())
const activeSessions = vi.hoisted(() => new Map<string, { config: Record<string, unknown> }>())
const stopSession = vi.hoisted(() => vi.fn())

vi.mock('./state', () => ({ engineBridge: { activeSessions, startSession, stopSession } }))
vi.mock('./logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('./tool-gate-responder', () => ({
  toolGateSessionConfig: () => ({
    enabled: true,
    tools: ['Write'],
    clientTools: [{ name: 'BenchMemberFile' }, { name: 'browser_navigate' }],
  }),
}))

import {
  browserToolsAvailable,
  handleSettingsChangeForBrowserTools,
  syncBrowserToolDeclarations,
} from './studio-browser-tool-sync'

beforeEach(() => {
  vi.clearAllMocks()
  activeSessions.clear()
})

describe('availability', () => {
  it('requires Studio to be the active UI and the setting to be on', () => {
    expect(browserToolsAvailable({ activeUi: 'studio', studioPlaywrightEnabled: true })).toBe(true)
    // Absent means enabled: the setting defaults on, so a settings file written
    // before the feature existed must not read as opted out.
    expect(browserToolsAvailable({ activeUi: 'studio' })).toBe(true)
    expect(browserToolsAvailable({ activeUi: 'studio', studioPlaywrightEnabled: false })).toBe(false)
    expect(browserToolsAvailable({ activeUi: 'overlay', studioPlaywrightEnabled: true })).toBe(false)
  })
})

describe('declaration resync', () => {
  it('re-asserts the full config for every live session', () => {
    activeSessions.set('tab-1', { config: { model: 'a', cwd: '/one' } })
    activeSessions.set('tab-2', { config: { model: 'b', cwd: '/two' } })

    syncBrowserToolDeclarations('test')

    expect(startSession).toHaveBeenCalledTimes(2)
    // The whole config is re-sent: a partial one would drop the model, cwd, and
    // permission settings the session was started with.
    expect(startSession).toHaveBeenCalledWith('tab-1', expect.objectContaining({ model: 'a', cwd: '/one', toolGate: expect.any(Object) }))
    expect(startSession).toHaveBeenCalledWith('tab-2', expect.objectContaining({ model: 'b', cwd: '/two' }))
  })

  it('never stops or restarts a session to change its tools', () => {
    activeSessions.set('tab-1', { config: {} })
    syncBrowserToolDeclarations('test')
    // Discarding conversation state to change a tool list would be a far larger
    // side effect than the setting the operator toggled.
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('keeps converging when one session fails', () => {
    activeSessions.set('bad', { config: {} })
    activeSessions.set('good', { config: {} })
    startSession.mockImplementation((key: string) => {
      if (key === 'bad') throw new Error('socket closed')
    })

    syncBrowserToolDeclarations('test')
    // One wedged session must not leave the others advertising a stale list.
    expect(startSession).toHaveBeenCalledTimes(2)
  })

  it('does nothing when no sessions are live', () => {
    syncBrowserToolDeclarations('test')
    expect(startSession).not.toHaveBeenCalled()
  })
})

describe('settings funnel', () => {
  it('resyncs when the setting is turned off', () => {
    activeSessions.set('tab-1', { config: {} })
    handleSettingsChangeForBrowserTools(
      { activeUi: 'studio', studioPlaywrightEnabled: false },
      { activeUi: 'studio', studioPlaywrightEnabled: true },
    )
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('resyncs when the active UI switches', () => {
    activeSessions.set('tab-1', { config: {} })
    handleSettingsChangeForBrowserTools(
      { activeUi: 'studio', studioPlaywrightEnabled: true },
      { activeUi: 'overlay', studioPlaywrightEnabled: true },
    )
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('ignores writes that do not change effective availability', () => {
    activeSessions.set('tab-1', { config: {} })
    handleSettingsChangeForBrowserTools(
      { activeUi: 'studio', studioPlaywrightEnabled: true, uiZoom: 1.1 },
      { activeUi: 'studio', studioPlaywrightEnabled: true, uiZoom: 1 },
    )
    // Re-asserting every session on every unrelated settings write would be a
    // lot of engine traffic for no behavioural difference.
    expect(startSession).not.toHaveBeenCalled()
  })
})
