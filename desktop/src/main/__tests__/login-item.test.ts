/** login-item: the system's login item follows the `openAtLogin` device setting. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {} } }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const settings = vi.hoisted(() => ({ file: '', value: {} as Record<string, unknown> }))
vi.mock('../device-settings', () => ({ deviceSettingsFile: () => settings.file, readDeviceSettings: () => settings.value }))

import { applyOpenAtLogin, startLoginItem, stopLoginItem, type LoginItemApp } from '../login-item'

function fakeApp(over: Partial<LoginItemApp> = {}): LoginItemApp & { calls: boolean[]; registered: boolean } {
  const state = { calls: [] as boolean[], registered: false }
  return Object.assign(state, {
    isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: state.registered }),
    setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => { state.calls.push(openAtLogin); state.registered = openAtLogin },
    ...over,
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-login-item-'))
  settings.file = join(dir, 'desktop.json')
  settings.value = {}
})
afterEach(() => { stopLoginItem(); rmSync(dir, { recursive: true, force: true }) })

describe('applyOpenAtLogin', () => {
  it('registers Ion when the setting is on, and removes it when off', () => {
    const app = fakeApp()
    expect(applyOpenAtLogin(true, app)).toBe('set')
    expect(app.registered).toBe(true)
    expect(applyOpenAtLogin(true, app)).toBe('unchanged')
    expect(applyOpenAtLogin(false, app)).toBe('set')
    expect(app.calls).toEqual([true, false])
  })

  it('never registers a development build', () => {
    const app = fakeApp({ isPackaged: false })
    expect(applyOpenAtLogin(true, app)).toBe('skipped')
    expect(app.calls).toEqual([])
  })

  it('reports a system that refuses instead of throwing', () => {
    const app = fakeApp({ setLoginItemSettings: () => { throw new Error('denied') } })
    expect(applyOpenAtLogin(true, app)).toBe('skipped')
  })
})

describe('startLoginItem', () => {
  it('applies the setting at start, and again when another process changes the settings file', async () => {
    const app = fakeApp()
    writeFileSync(settings.file, '{}')
    startLoginItem(app)
    expect(app.calls).toEqual([])
    // An `ion fleet` deploy turns the setting on in the file. The write is repeated: a watch that has only just started can miss the first event.
    settings.value = { openAtLogin: true }
    for (let i = 0; i < 40 && app.calls.length === 0; i++) {
      writeFileSync(settings.file, `{"openAtLogin":true,"n":${i}}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(app.calls).toEqual([true])
  })

  it('registers at start when the setting is already on', () => {
    settings.value = { openAtLogin: true }
    const app = fakeApp()
    startLoginItem(app)
    expect(app.calls).toEqual([true])
  })
})
