/**
 * The Build Notice's main-process half: a packaged build this device has not
 * acknowledged gets a notice, acknowledging it records that exact build, and
 * the next build of the same commit gets a notice again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ packaged: true, stored: {} as Record<string, unknown>, sealed: {} as Record<string, unknown> }))

vi.mock('electron', () => ({
  app: { get isPackaged() { return state.packaged } },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('../device-settings', () => ({
  readStoredDeviceSettings: () => ({ ...state.stored }),
  // The settings in force: what is stored, under the values device policy seals.
  readDeviceSettings: () => ({ ...state.stored, ...state.sealed }),
  updateDeviceSetting: (key: string, value: unknown) => { state.stored[key] = value },
}))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

function stubBuild(builtAt: string): void {
  vi.stubGlobal('__ION_DESKTOP_VERSION__', '2.10.0-dev.abc')
  vi.stubGlobal('__ION_DESKTOP_BUILT_AT__', builtAt)
  vi.stubGlobal('__ION_DESKTOP_WHATS_NEW__', ['Studio says when it was updated.'])
}

const { acknowledgeBuild, currentBuildNotice } = await import('../build-notice')

beforeEach(() => {
  state.packaged = true
  state.stored = {}
  state.sealed = {}
  stubBuild('2026-10-05T15:00:00.000Z')
})

describe('build notice', () => {
  it('shows an unacknowledged build, then stops once it is acknowledged', () => {
    expect(currentBuildNotice()?.current).toEqual({ version: '2.10.0-dev.abc', builtAt: '2026-10-05T15:00:00.000Z' })
    acknowledgeBuild()
    expect(state.stored.acknowledgedDesktopBuild).toEqual({ version: '2.10.0-dev.abc', builtAt: '2026-10-05T15:00:00.000Z' })
    expect(currentBuildNotice()).toBeNull()
  })

  it('shows a rebuild of the same commit as a new build', () => {
    acknowledgeBuild()
    stubBuild('2026-10-05T16:00:00.000Z')
    const notice = currentBuildNotice()
    expect(notice?.previous?.builtAt).toBe('2026-10-05T15:00:00.000Z')
  })

  it('carries the notes baked into the build', () => {
    expect(currentBuildNotice()?.highlights).toEqual(['Studio says when it was updated.'])
  })

  it('shows nothing when the setting is off, and records the build as seen', () => {
    state.stored.showBuildNotice = false
    expect(currentBuildNotice()).toBeNull()
    expect(state.stored.acknowledgedDesktopBuild).toEqual({ version: '2.10.0-dev.abc', builtAt: '2026-10-05T15:00:00.000Z' })
    state.stored.showBuildNotice = true
    expect(currentBuildNotice()).toBeNull()
    stubBuild('2026-10-05T16:00:00.000Z')
    expect(currentBuildNotice()?.current.builtAt).toBe('2026-10-05T16:00:00.000Z')
  })

  it('follows device policy over the stored setting', () => {
    state.stored.showBuildNotice = true
    state.sealed.showBuildNotice = false
    expect(currentBuildNotice()).toBeNull()
    state.stored = {}
    state.stored.showBuildNotice = false
    state.sealed.showBuildNotice = true
    expect(currentBuildNotice()).not.toBeNull()
  })

  it('never shows in an unpackaged dev run', () => {
    state.packaged = false
    expect(currentBuildNotice()).toBeNull()
  })
})
