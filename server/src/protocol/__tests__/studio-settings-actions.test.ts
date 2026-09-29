/**
 * `studio.setSetting` accepts exactly the Studio window's own keys, with the
 * per-key shape checks in `persistence/studio-settings-keys`, and persists
 * into the caller's own overlay. These cases moved from the desktop's IPC
 * adapter when that adapter was deleted; the validator is shared, so the
 * wire is where it is pinned now.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({
  writeSettingsForSubject: vi.fn(),
  readSettingsForSubject: vi.fn(() => ({ studioZoom: 2 })),
}))
vi.mock('../../persistence/user-settings-store', () => store)
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { STUDIO_SETTINGS_ACTIONS } from '../studio-settings-actions'
import type { Connection } from '../connection'

const conn = { id: 'c1', principal: { subject: 'local:josh' } } as unknown as Connection
const set = (key: unknown, value: unknown) => STUDIO_SETTINGS_ACTIONS['studio.setSetting'].handler(conn, [key, value])

beforeEach(() => { store.writeSettingsForSubject.mockClear() })

describe('studio.setSetting validation', () => {
  it('rejects keys outside the Studio window allowlist', async () => {
    expect(await set('gitOpsMode', 'manual')).toEqual({ ok: true, value: false })
    expect(await set('themeMode', 'light')).toEqual({ ok: true, value: false })
    expect(store.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it('refuses a server setting instead of dropping it into the callers overlay', async () => {
    // studioPlaywrightEnabled used to be on the allowlist: the write landed in
    // the overlay, the server kept reading its own document, and the caller
    // was told it had worked.
    for (const [key, value] of [['studioPlaywrightEnabled', false], ['relayApiKey', 'steal']] as const) {
      expect(await set(key, value), key).toMatchObject({ ok: false, error: { code: 'wrong_scope' } })
    }
    expect(store.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it('validates per-key value shapes', async () => {
    for (const [key, value] of [['studioZoom', 2.5], ['studioZoom', 99], ['studioPinned', true], ['studioTheme', 'Bad Theme!'], ['studioSeed', 42], ['studioSeed', 'x'.repeat(300)]] as const) {
      expect(await set(key, value), `${key}`).toEqual({ ok: true, value: false })
    }
    expect(store.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it('persists valid values into the callers overlay', async () => {
    expect(await set('studioZoom', 0)).toEqual({ ok: true, value: true }) // fit mode
    expect(await set('studioZoom', 3)).toEqual({ ok: true, value: true })
    expect(await set('studioSeed', 'my-office')).toEqual({ ok: true, value: true })
    expect(await set('studioSeed', '')).toEqual({ ok: true, value: true }) // reset to default
    expect(store.writeSettingsForSubject).toHaveBeenCalledTimes(4)
    expect(store.writeSettingsForSubject).toHaveBeenLastCalledWith('local:josh', { studioSeed: '' })
  })

  it('studioLayout: accepts every complete normalized layout the shell can persist', async () => {
    for (const view of ['inbox', 'explorer', 'git']) {
      const layout = { leftSidebarVisible: true, leftSidebarView: view, surfaceWidth: 520, terminalHeight: 240, dispatchSplitRatio: 0.45 }
      expect(await set('studioLayout', layout), view).toEqual({ ok: true, value: true })
    }
  })

  it('studioLayout: rejects out-of-bounds sizes, bad views, and partial shapes', async () => {
    const good = { leftSidebarVisible: false, leftSidebarView: 'explorer', surfaceWidth: 520, terminalHeight: 240, dispatchSplitRatio: 0.45 }
    for (const bad of [
      { ...good, surfaceWidth: 10 },
      { ...good, terminalHeight: 9999 },
      { ...good, dispatchSplitRatio: 0.05 },
      { ...good, leftSidebarView: 'bogus' },
      { leftSidebarVisible: true },
      { ...good, extraKey: 1 },
      null,
    ]) {
      expect(await set('studioLayout', bad)).toEqual({ ok: true, value: false })
    }
  })

  it('reads project the callers overlay through the Studio key allowlist', async () => {
    const outcome = await STUDIO_SETTINGS_ACTIONS['studio.getSettings'].handler(conn, [])
    expect(outcome.ok).toBe(true)
    expect((outcome as { value: Record<string, unknown> }).value.studioZoom).toBe(2)
  })
})
