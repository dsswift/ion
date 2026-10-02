import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreferencesState } from '@ion/server/preferences-types'

const applyTheme = vi.fn()
vi.mock('./theme-tokens', () => ({ applyTheme: (id: string) => applyTheme(id) }))
vi.mock('./preferences-persist', () => ({ saveSettings: vi.fn() }))
vi.mock('./host/host-instance', () => ({ host: {} }))
vi.mock('./rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))

import {
  ACCOUNT_WATERMARKS_KEY,
  CLIENT_WATERMARKS_KEY,
  reconcileManagedDefaults,
  type ManagedDefaultsIo,
} from './managed-defaults'
import { rInfo, rWarn } from './rendererLogger'

type ManagedState = Pick<PreferencesState, 'selectedTheme' | 'defaultBaseDirectory' | 'defaultEngineProfileId' | 'terminalFontSize' | 'enterprisePolicy' | 'enterpriseNewConversationDefaults'>

/** A preference store and the two settings documents behind it, as one installation across launches. */
function installation(initial: Partial<ManagedState> = {}) {
  let state: ManagedState = {
    selectedTheme: 'ion-dark',
    defaultBaseDirectory: '',
    defaultEngineProfileId: '',
    terminalFontSize: 13,
    enterprisePolicy: null,
    enterpriseNewConversationDefaults: null,
    ...initial,
  }
  const client: Record<string, unknown> = {}
  const server: Record<string, unknown> = {}
  const saves: Array<Record<string, unknown>> = []
  const clientWrites: Array<Record<string, unknown>> = []
  const store = {
    getState: () => state as PreferencesState,
    setState: (patch: Partial<PreferencesState>) => { state = { ...state, ...patch } },
  }
  const io: ManagedDefaultsIo = {
    readClient: async () => ({ ...client }),
    readServer: async () => ({ ...server }),
    save: (patch) => {
      saves.push(patch)
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'selectedTheme' || key === 'terminalFontSize' || key === CLIENT_WATERMARKS_KEY) client[key] = value
        else server[key] = value
      }
    },
    writeClientSetting: (key, value) => { clientWrites.push({ [key]: value }) },
  }
  return {
    state: () => state,
    saves,
    clientWrites,
    /** Loads a device policy whose `settingsPolicy` block carries these keys. */
    loadSettingsPolicy: (keys: Record<string, { class: string; value?: unknown }>) => {
      state = {
        ...state,
        enterprisePolicy: { customFields: { 'ion-desktop': { settingsPolicy: { keys } } } } as unknown as PreferencesState['enterprisePolicy'],
      }
      return reconcileManagedDefaults(store as never, io)
    },
    client,
    server,
    io,
    userSets: (patch: Partial<ManagedState>) => { state = { ...state, ...patch } },
    load: (policy: { themeId?: string; themeLocked?: boolean; baseDirectory?: string; engineProfileId?: string; locked?: boolean }) => {
      state = {
        ...state,
        enterprisePolicy: policy.themeId
          ? ({ customFields: { 'ion-desktop': { themePolicy: { themeId: policy.themeId, locked: policy.themeLocked } } } } as unknown as PreferencesState['enterprisePolicy'])
          : null,
        enterpriseNewConversationDefaults: policy.baseDirectory || policy.engineProfileId
          ? { baseDirectory: policy.baseDirectory ?? '', engineProfileId: policy.engineProfileId ?? '', locked: policy.locked === true }
          : null,
      }
      return reconcileManagedDefaults(store as never, io)
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('theme managed default', () => {
  // The defect this replaced: the default applied only to a profile that had
  // never picked a theme, so no existing installation ever received one.
  it('reaches an installation that already picked a theme', async () => {
    localStorage.setItem('ion_selectedTheme', 'ion-light')
    const install = installation({ selectedTheme: 'ion-light' })
    await install.load({ themeId: 'acme' })
    expect(install.state().selectedTheme).toBe('acme')
    expect(applyTheme).toHaveBeenCalledWith('acme')
    expect(localStorage.getItem('ion_selectedTheme')).toBe('acme')
    expect(install.client[CLIENT_WATERMARKS_KEY]).toEqual({ selectedTheme: 'acme' })
    expect(rInfo).toHaveBeenCalledWith('preferences', 'enterprise managed default applied; preference overwritten', expect.objectContaining({ key: 'selectedTheme', policy_value: 'acme' }))
  })

  it('leaves a later choice alone while the policy value is unchanged', async () => {
    const install = installation()
    await install.load({ themeId: 'acme' })
    install.userSets({ selectedTheme: 'ion-light' })
    applyTheme.mockClear()
    await install.load({ themeId: 'acme' })
    expect(install.state().selectedTheme).toBe('ion-light')
    expect(applyTheme).not.toHaveBeenCalled()
    expect(install.saves).toHaveLength(1)
  })

  it('overwrites that choice when the policy value changes', async () => {
    const install = installation()
    await install.load({ themeId: 'acme' })
    install.userSets({ selectedTheme: 'ion-light' })
    await install.load({ themeId: 'acme-2' })
    expect(install.state().selectedTheme).toBe('acme-2')
    expect(install.client[CLIENT_WATERMARKS_KEY]).toEqual({ selectedTheme: 'acme-2' })
  })

  it('writes nothing under a locked policy', async () => {
    const install = installation({ selectedTheme: 'ion-light' })
    await install.load({ themeId: 'acme', themeLocked: true })
    expect(install.state().selectedTheme).toBe('ion-light')
    expect(install.saves).toEqual([])
  })
})

describe('new-conversation managed defaults', () => {
  it('seeds both preferences and keeps their watermarks with the account', async () => {
    const install = installation({ defaultBaseDirectory: '/home/me' })
    await install.load({ baseDirectory: '/corp', engineProfileId: 'dev' })
    expect(install.state().defaultBaseDirectory).toBe('/corp')
    expect(install.state().defaultEngineProfileId).toBe('dev')
    // One save: a refused save can never record a default that was not stored.
    expect(install.saves).toEqual([{
      defaultBaseDirectory: '/corp',
      defaultEngineProfileId: 'dev',
      [ACCOUNT_WATERMARKS_KEY]: { defaultBaseDirectory: '/corp', defaultEngineProfileId: 'dev' },
    }])
    expect(install.client[CLIENT_WATERMARKS_KEY]).toBeUndefined()
  })

  it('moves each preference independently', async () => {
    const install = installation()
    await install.load({ baseDirectory: '/corp', engineProfileId: 'dev' })
    install.userSets({ defaultBaseDirectory: '/mine', defaultEngineProfileId: 'mine' })
    await install.load({ baseDirectory: '/corp', engineProfileId: 'ops' })
    expect(install.state().defaultBaseDirectory).toBe('/mine')
    expect(install.state().defaultEngineProfileId).toBe('ops')
  })

  it('writes nothing under a locked policy', async () => {
    const install = installation({ defaultBaseDirectory: '/mine' })
    await install.load({ baseDirectory: '/corp', engineProfileId: 'dev', locked: true })
    expect(install.state().defaultBaseDirectory).toBe('/mine')
    expect(install.saves).toEqual([])
  })
})

describe('settings-policy managed defaults', () => {
  it('supplies a value once, and again only when the policy value changes', async () => {
    const install = installation()
    await install.loadSettingsPolicy({ terminalFontSize: { class: 'managed-default', value: 16 } })
    expect(install.state().terminalFontSize).toBe(16)
    // One save, with the watermark beside the preference.
    expect(install.saves).toEqual([{ terminalFontSize: 16, [CLIENT_WATERMARKS_KEY]: { terminalFontSize: '16' } }])
    // The person changes it; the same policy leaves their choice alone.
    install.userSets({ terminalFontSize: 12 })
    await install.loadSettingsPolicy({ terminalFontSize: { class: 'managed-default', value: 16 } })
    expect(install.state().terminalFontSize).toBe(12)
    expect(install.saves).toHaveLength(1)
    // A new policy value is supplied.
    await install.loadSettingsPolicy({ terminalFontSize: { class: 'managed-default', value: 18 } })
    expect(install.state().terminalFontSize).toBe(18)
  })

  it('does not supply or record a value of the wrong shape', async () => {
    const install = installation()
    await install.loadSettingsPolicy({ terminalFontSize: { class: 'managed-default', value: 'large' } })
    expect(install.state().terminalFontSize).toBe(13)
    expect(install.saves).toEqual([])
  })

  it('writes a setting the preference store does not hold to this client', async () => {
    const install = installation()
    await install.loadSettingsPolicy({ studioExampleFlag: { class: 'managed-default', value: true } })
    expect(install.clientWrites).toEqual([{ studioExampleFlag: true }])
    expect(install.client[CLIENT_WATERMARKS_KEY]).toEqual({ studioExampleFlag: 'true' })
    await install.loadSettingsPolicy({ studioExampleFlag: { class: 'managed-default', value: true } })
    expect(install.clientWrites).toHaveLength(1)
  })

  it('applies a theme entry once, through the theme row', async () => {
    const install = installation({ selectedTheme: 'ion-light' })
    await install.loadSettingsPolicy({ selectedTheme: { class: 'managed-default', value: 'acme' } })
    expect(install.state().selectedTheme).toBe('acme')
    expect(install.client[CLIENT_WATERMARKS_KEY]).toEqual({ selectedTheme: 'acme' })
    expect(applyTheme).toHaveBeenCalledTimes(1)
  })
})

describe('reconcile failures', () => {
  it('applies nothing when the watermarks cannot be read, and says so', async () => {
    const install = installation({ selectedTheme: 'ion-light' })
    install.io.readClient = async () => { throw new Error('unreadable') }
    await install.load({ themeId: 'acme' })
    expect(install.state().selectedTheme).toBe('ion-light')
    expect(install.saves).toEqual([])
    expect(rWarn).toHaveBeenCalledWith('preferences', 'managed defaults not reconciled; will retry on the next policy load', { error: 'unreadable' })
  })

  it('reads nothing on an unmanaged installation', async () => {
    const install = installation()
    install.io.readClient = vi.fn(async () => ({}))
    install.io.readServer = vi.fn(async () => ({}))
    await install.load({})
    expect(install.io.readClient).not.toHaveBeenCalled()
    expect(install.io.readServer).not.toHaveBeenCalled()
  })
})
