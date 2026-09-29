// @vitest-environment jsdom
/**
 * A Personal preference lives on this client and is declared to each server,
 * on every welcome and on every change. A server keeps nothing between
 * connections, so a reconnect that did not re-declare would run new
 * conversations under defaults the person never chose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  frame: null as null | ((environmentId: string, frame: Record<string, unknown>) => void),
  action: vi.fn(async (..._args: unknown[]) => true),
  prefs: { defaultPermissionMode: 'auto', defaultThinkingEffort: 'high', aiGeneratedTitles: true, enableClaudeCompat: true, enableEarlyStopContinuation: false, selectedTheme: 'dusk', preferredModel: 'm' } as Record<string, unknown>,
  listeners: new Set<() => void>(),
}))
vi.mock('../../../host/host-instance', () => ({
  host: { onFrame: (cb: typeof wire.frame) => { wire.frame = cb; return () => { wire.frame = null } } },
  action: wire.action,
}))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: {
    getState: () => wire.prefs,
    subscribe: (cb: () => void) => { wire.listeners.add(cb); return () => wire.listeners.delete(cb) },
  },
}))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

import { currentPersonalPreferences, initPreferenceDeclaration } from '../declare-preferences'

const TRAVELLING = { defaultPermissionMode: 'auto', defaultThinkingEffort: 'high', aiGeneratedTitles: true, enableClaudeCompat: true, enableEarlyStopContinuation: false }

beforeEach(() => {
  wire.action.mockClear()
  wire.listeners.clear()
  wire.prefs.aiGeneratedTitles = true
  initPreferenceDeclaration()
})

describe('preference declaration', () => {
  it('declares only what a server consumes: no theme, no Account setting', () => {
    expect(currentPersonalPreferences()).toEqual(TRAVELLING)
  })

  it('declares to a server on every welcome, including a reconnect', () => {
    wire.frame!('env-remote', { type: 'studio_welcome' })
    wire.frame!('env-remote', { type: 'studio_welcome' })
    expect(wire.action).toHaveBeenCalledTimes(2)
    expect(wire.action).toHaveBeenLastCalledWith('env-remote', 'preferences.declare', [TRAVELLING])
  })

  it('re-declares to every connected server when a travelling preference changes', () => {
    wire.frame!('local', { type: 'studio_welcome' })
    wire.frame!('env-remote', { type: 'studio_welcome' })
    wire.action.mockClear()

    wire.prefs.aiGeneratedTitles = false
    wire.listeners.forEach((cb) => cb())

    expect(wire.action.mock.calls.map((c) => c[0]).sort()).toEqual(['env-remote', 'local'])
    expect(wire.action).toHaveBeenCalledWith('local', 'preferences.declare', [{ ...TRAVELLING, aiGeneratedTitles: false }])
  })

  it('stays quiet when something else in the store changes', () => {
    wire.frame!('local', { type: 'studio_welcome' })
    wire.action.mockClear()
    wire.prefs.selectedTheme = 'dawn'
    wire.listeners.forEach((cb) => cb())
    expect(wire.action).not.toHaveBeenCalled()
  })
})
