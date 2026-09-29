/**
 * Pins the `studio.*` read surface the Visualizer needs on every host.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const deps = vi.hoisted(() => ({
  getRemoteTabStates: vi.fn(),
  allStudioSummaries: vi.fn(),
  readSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  listThemePacks: vi.fn(),
  readPackBundle: vi.fn(),
  readThemeAsset: vi.fn(),
  readIosThemeAsset: vi.fn(),
}))
vi.mock('../../remote/snapshot', () => ({ getRemoteTabStates: deps.getRemoteTabStates }))
vi.mock('../../engine/studio-state-cache', () => ({ allStudioSummaries: deps.allStudioSummaries }))
vi.mock('../../persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../persistence/settings-store')>()), readSettings: deps.readSettings }))
vi.mock('../../studio-theme-packs', () => ({
  listThemePacks: deps.listThemePacks,
  readPackBundle: deps.readPackBundle,
  readThemeAsset: deps.readThemeAsset,
}))
vi.mock('../../theme-packs', () => ({ readIosThemeAsset: deps.readIosThemeAsset }))

import { STUDIO_ACTIONS } from '../studio-actions'
import { MISC_ACTIONS } from '../misc-actions'
import type { Connection } from '../connection'

const alice = { id: 'c1', scopes: [], principal: { subject: 'oidc:alice' } } as unknown as Connection

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockClear()
  deps.getRemoteTabStates.mockResolvedValue({
    tabs: [
      { id: 'tab-1', title: 'One', customTitle: '', status: 'idle', workingDirectory: '/home/a/proj', engineProfileId: 'example-profile' },
      { id: 'tab-2', title: 'Two', customTitle: 'Renamed', status: 'running', workingDirectory: '/home/a/other' },
      { id: 'term', title: 'T', status: 'idle', workingDirectory: '/x', isTerminalOnly: true },
    ],
    resourceManifest: {},
  })
  deps.allStudioSummaries.mockReturnValue([
    { tabId: 'tab-1', state: 'idle', working: 0, error: 0, total: 1, pendingPermissions: 0 },
    { tabId: 'hidden', state: 'running', working: 2, error: 0, total: 2, pendingPermissions: 0 },
  ])
})

describe('STUDIO_ACTIONS', () => {
  it('is dispatched through MISC_ACTIONS and every verb is a read', () => {
    for (const name of Object.keys(STUDIO_ACTIONS)) {
      expect(MISC_ACTIONS[name], name).toBe(STUDIO_ACTIONS[name])
      expect(STUDIO_ACTIONS[name].requiredScope, name).toBe('conversations:read')
    }
  })

  it('studio.listTabs lists the callers tabs by directory, skipping terminal-only tabs', async () => {
    const outcome = await STUDIO_ACTIONS['studio.listTabs'].handler(alice, [])
    expect(deps.getRemoteTabStates).toHaveBeenCalledWith('oidc:alice')
    expect(outcome).toEqual({
      ok: true,
      value: [
        { tabId: 'tab-1', title: 'One', status: 'idle', directory: 'proj', extension: 'example-profile', group: 'proj', groupOrder: 1000 },
        { tabId: 'tab-2', title: 'Renamed', status: 'running', directory: 'other', extension: '', group: 'other', groupOrder: 1000 },
      ],
    })
  })

  it('studio.allStatus returns summaries only for tabs the caller may see', async () => {
    const outcome = await STUDIO_ACTIONS['studio.allStatus'].handler(alice, [])
    expect(outcome).toEqual({ ok: true, value: [{ tabId: 'tab-1', state: 'idle', working: 0, error: 0, total: 1, pendingPermissions: 0 }] })
  })

  it('studio.listThemes and studio.readThemeBundle delegate to the pack reader', async () => {
    deps.listThemePacks.mockReturnValue([{ id: 'ion-works', name: 'Ion Works', version: '1', builtin: true }])
    deps.readPackBundle.mockReturnValue({ packId: 'ion-works' })
    expect(await STUDIO_ACTIONS['studio.listThemes'].handler(alice, [])).toEqual({ ok: true, value: [{ id: 'ion-works', name: 'Ion Works', version: '1', builtin: true }] })
    expect(await STUDIO_ACTIONS['studio.readThemeBundle'].handler(alice, ['ion-works'])).toEqual({ ok: true, value: { packId: 'ion-works' } })
    expect(await STUDIO_ACTIONS['studio.readThemeBundle'].handler(alice, [42])).toEqual({ ok: true, value: null })
    expect(deps.readPackBundle).toHaveBeenCalledTimes(1)
  })

  it('studio.readThemeAsset returns PNG bytes as base64 and null for a refused read', async () => {
    deps.readThemeAsset.mockReturnValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, ['ion-works', 'a.png'])).toEqual({ ok: true, value: 'iVBORw==' })
    deps.readThemeAsset.mockReturnValue(null)
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, ['ion-works', '../x.png'])).toEqual({ ok: true, value: null })
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, ['ion-works', 42])).toEqual({ ok: true, value: null })
  })

  it('reports a thrown read as action_failed rather than crashing the dispatcher', async () => {
    deps.listThemePacks.mockImplementation(() => { throw new Error('disk gone') })
    const outcome = await STUDIO_ACTIONS['studio.listThemes'].handler(alice, [])
    expect(outcome).toEqual({ ok: false, error: { code: 'action_failed', message: 'Error: disk gone' } })
  })

  it('studio.readThemeAsset by slot answers the hash and a data URL, and leaves the path form alone', async () => {
    deps.readIosThemeAsset.mockReturnValue({ sha256: 'abc123', dataUrl: 'data:image/png;base64,AAAA' })
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, [{ themeId: 'example-pack', slot: 'logo' }]))
      .toEqual({ ok: true, value: { sha256: 'abc123', dataUrl: 'data:image/png;base64,AAAA' } })
    expect(deps.readIosThemeAsset).toHaveBeenCalledWith('example-pack', 'logo')
    expect(deps.readThemeAsset).not.toHaveBeenCalled()

    deps.readThemeAsset.mockReturnValue(Buffer.from('png'))
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, ['example-pack', 'assets/bg.png']))
      .toEqual({ ok: true, value: Buffer.from('png').toString('base64') })
  })

  it('studio.readThemeAsset by slot answers null for a slot that does not exist or an asset that is missing', async () => {
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, [{ themeId: 'example-pack', slot: 'favicon' }])).toEqual({ ok: true, value: null })
    expect(deps.readIosThemeAsset).not.toHaveBeenCalled()
    deps.readIosThemeAsset.mockReturnValue(null)
    expect(await STUDIO_ACTIONS['studio.readThemeAsset'].handler(alice, [{ themeId: 'example-pack', slot: 'background' }])).toEqual({ ok: true, value: null })
  })
})
