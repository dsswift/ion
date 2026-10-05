/**
 * The Build Notice under device policy, through the real `desktop.json` store:
 * an organization that seals `showBuildNotice` off hides the notice on every
 * update, and a person cannot turn it back on; sealed on, a person cannot turn
 * it off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ion/server/paths', () => ({ dataDir: () => paths.dir }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: { handle: vi.fn() } }))

import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { noteDevicePolicyFrame, _resetDevicePolicyForTest } from '../device-policy'
import { requestDeviceSettingWrite } from '../device-settings'

vi.stubGlobal('__ION_DESKTOP_VERSION__', '2.10.0')
vi.stubGlobal('__ION_DESKTOP_BUILT_AT__', '2026-10-05T15:00:00.000Z')
vi.stubGlobal('__ION_DESKTOP_WHATS_NEW__', [])
const { currentBuildNotice } = await import('../build-notice')

function seal(value: boolean): void {
  const settingsPolicy = { keys: { showBuildNotice: { class: 'sealed', value } } }
  const frame = { type: 'studio_environment_policy', enterprisePolicy: { customFields: { 'ion-desktop': { settingsPolicy } } }, settingsHiddenGroups: [], policyHash: 'h' }
  noteDevicePolicyFrame(LOCAL_ENVIRONMENT_ID, frame as StudioFrame)
}

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-build-notice-policy-'))
  _resetDevicePolicyForTest()
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('build notice under device policy', () => {
  it('shows by default', () => {
    expect(currentBuildNotice()).not.toBeNull()
  })

  it('sealed off: hidden, and a person cannot turn it back on', () => {
    seal(false)
    expect(requestDeviceSettingWrite('showBuildNotice', true)).toMatchObject({ ok: false, code: 'settings_sealed', key: 'showBuildNotice' })
    expect(currentBuildNotice()).toBeNull()
  })

  it('sealed on: shown, and a person cannot turn it off', () => {
    seal(true)
    expect(requestDeviceSettingWrite('showBuildNotice', false)).toMatchObject({ ok: false, code: 'settings_sealed' })
    expect(currentBuildNotice()).not.toBeNull()
  })

  it('a person may turn it off with no policy', () => {
    expect(requestDeviceSettingWrite('showBuildNotice', false)).toEqual({ ok: true })
    expect(currentBuildNotice()).toBeNull()
  })
})
