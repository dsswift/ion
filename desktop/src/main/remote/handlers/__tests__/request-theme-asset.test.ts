/**
 * handleRequestThemeAsset — lazy theme-pack asset fetch over the wire.
 *
 * Pins: a declared asset answers ok=true with dataUrl + scan-time sha256
 * to the REQUESTING device only; unknown packs/slots and malformed slots
 * answer ok=false (never silent); containment and size violations are the
 * loader's job (covered in theme-packs.test.ts) and surface here as
 * ok=false too.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IOS_THEME_TOKEN_KEYS } from '../../../../shared/theme-pack-types'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

const { mockSendToDevice } = vi.hoisted(() => ({ mockSendToDevice: vi.fn() }))

vi.mock('../../../state', () => ({
  state: { remoteTransport: { sendToDevice: mockSendToDevice } },
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { handleRequestThemeAsset } from '../themes'
import { resetThemePacksForTest } from '../../../theme-packs'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let userRoot: string
let systemRoot: string

beforeEach(() => {
  userRoot = mkdtempSync(join(tmpdir(), 'ion-theme-asset-user-'))
  systemRoot = mkdtempSync(join(tmpdir(), 'ion-theme-asset-system-'))
  resetThemePacksForTest({ user: userRoot, system: systemRoot })
  mockSendToDevice.mockClear()

  const dir = join(userRoot, 'acme-corp')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'bg.png'), PNG_BYTES)
  writeFileSync(join(dir, 'theme.json'), JSON.stringify({
    id: 'acme-corp',
    name: 'Acme Corp',
    version: '1.0.0',
    ios: {
      tokens: Object.fromEntries(IOS_THEME_TOKEN_KEYS.map((k) => [k, '#FF6600FF'])),
      assets: { background: 'assets/bg.png' },
    },
  }))
})

afterEach(() => {
  resetThemePacksForTest()
  rmSync(userRoot, { recursive: true, force: true })
  rmSync(systemRoot, { recursive: true, force: true })
})

describe('handleRequestThemeAsset', () => {
  it('serves a declared asset to the requesting device', () => {
    handleRequestThemeAsset({ type: 'desktop_request_theme_asset', themeId: 'acme-corp', slot: 'background' }, 'device-A')
    expect(mockSendToDevice).toHaveBeenCalledTimes(1)
    const [deviceId, event] = mockSendToDevice.mock.calls[0]
    expect(deviceId).toBe('device-A')
    expect(event.type).toBe('desktop_theme_asset_content')
    expect(event.themeId).toBe('acme-corp')
    expect(event.slot).toBe('background')
    expect(event.ok).toBe(true)
    expect(event.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(event.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('answers ok=false for an undeclared slot', () => {
    handleRequestThemeAsset({ type: 'desktop_request_theme_asset', themeId: 'acme-corp', slot: 'logo' }, 'device-A')
    const [, event] = mockSendToDevice.mock.calls[0]
    expect(event.ok).toBe(false)
    expect(event.dataUrl).toBeUndefined()
  })

  it('answers ok=false for an unknown pack', () => {
    handleRequestThemeAsset({ type: 'desktop_request_theme_asset', themeId: 'nope', slot: 'background' }, 'device-A')
    const [, event] = mockSendToDevice.mock.calls[0]
    expect(event.ok).toBe(false)
  })

  it('answers ok=false for a malformed slot value (wire-level defense)', () => {
    handleRequestThemeAsset(
      { type: 'desktop_request_theme_asset', themeId: 'acme-corp', slot: '../escape' as 'background' },
      'device-A',
    )
    const [, event] = mockSendToDevice.mock.calls[0]
    expect(event.ok).toBe(false)
  })
})
