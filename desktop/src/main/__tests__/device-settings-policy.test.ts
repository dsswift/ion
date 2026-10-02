/**
 * Device policy on `desktop.json`: a sealed setting is refused to a writer,
 * reads as the policy's value, and keeps what the person saved underneath.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ion/server/paths', () => ({ dataDir: () => paths.dir }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { noteDevicePolicyFrame, _resetDevicePolicyForTest } from '../device-policy'
import { readDeviceSettings, requestDeviceSettingWrite, updateDeviceSetting } from '../device-settings'

function announce(settingsPolicy: unknown, environmentId: string = LOCAL_ENVIRONMENT_ID): void {
  const frame = { type: 'studio_environment_policy', enterprisePolicy: { customFields: { 'ion-desktop': { settingsPolicy } } }, settingsHiddenGroups: [], policyHash: 'h' }
  noteDevicePolicyFrame(environmentId, frame as StudioFrame)
}

const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(join(paths.dir, 'desktop.json'), 'utf-8'))

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-device-policy-'))
  _resetDevicePolicyForTest()
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('device settings under device policy', () => {
  it('writes freely with no policy', () => {
    expect(requestDeviceSettingWrite('terminalFontSize', 15)).toEqual({ ok: true })
    expect(readDeviceSettings().terminalFontSize).toBe(15)
  })

  it('refuses a sealed key, naming the key and its class, and writes nothing', () => {
    updateDeviceSetting('terminalFontSize', 15)
    announce({ keys: { terminalFontSize: { class: 'sealed' } } })
    expect(requestDeviceSettingWrite('terminalFontSize', 20)).toMatchObject({ ok: false, code: 'settings_sealed', key: 'terminalFontSize', class: 'sealed' })
    expect(onDisk().terminalFontSize).toBe(15)
    expect(requestDeviceSettingWrite('soundEnabled', false)).toEqual({ ok: true })
  })

  it('fails closed under a sealed default, and opens what the policy opens', () => {
    announce({ defaultClass: 'sealed', keys: { selectedTheme: { class: 'user-adjustable' } } })
    expect(requestDeviceSettingWrite('soundEnabled', false).ok).toBe(false)
    expect(requestDeviceSettingWrite('selectedTheme', 'ion-light')).toEqual({ ok: true })
    // What the app records on its own is not a setting the default reaches.
    expect(requestDeviceSettingWrite('gitPanelHeight', 320)).toEqual({ ok: true })
  })

  it('reads the sealed value and keeps the saved one on disk for when the seal lifts', () => {
    updateDeviceSetting('terminalFontSize', 15)
    announce({ keys: { terminalFontSize: { class: 'sealed', value: 11 } } })
    expect(readDeviceSettings().terminalFontSize).toBe(11)
    // The app's own write of another key must not save the policy value.
    updateDeviceSetting('environmentViewFilter', 'all')
    expect(onDisk().terminalFontSize).toBe(15)
    announce({})
    expect(readDeviceSettings().terminalFontSize).toBe(15)
  })

  it('does not serve a sealed value of the wrong type, and still refuses the write', () => {
    updateDeviceSetting('terminalFontSize', 15)
    announce({ keys: { terminalFontSize: { class: 'sealed', value: 'large' } } })
    expect(readDeviceSettings().terminalFontSize).toBe(15)
    expect(requestDeviceSettingWrite('terminalFontSize', 20).ok).toBe(false)
  })

  it('ignores a policy announced by any other Environment', () => {
    announce({ defaultClass: 'sealed' }, 'env-remote')
    expect(requestDeviceSettingWrite('soundEnabled', false)).toEqual({ ok: true })
  })
})
