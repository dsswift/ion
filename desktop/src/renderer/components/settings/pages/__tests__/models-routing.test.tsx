// @vitest-environment jsdom
/**
 * Routing and defaults on Providers & models: the default provider row, the
 * model tiers table and its Add tier panel, and the default model pickers.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelTier } from '@ion/shared/types-model-tiers'
import { createHarness, flush, type Harness } from './page-harness'
import { installFakeWire, emitOnChannel } from '../../../../host/__tests__/fake-wire'

const store = vi.hoisted(() => ({
  state: {
    models: [{ id: 'model-a', providerId: 'test' }, { id: 'model-b', providerId: 'test' }, { id: 'claude-opus-5', providerId: 'corp-gateway' }] as Array<{ id: string; providerId: string }>,
    providers: [{ id: 'anthropic', hasAuth: true }, { id: 'corp-gateway', hasAuth: true }, { id: 'test', hasAuth: true }, { id: 'unauthed-provider', hasAuth: false }] as Array<{ id: string; hasAuth: boolean }>,
    loading: false,
    loginStates: {},
    fetchModelsFor: async (): Promise<void> => undefined,
  },
}))
vi.mock('@ion/server/store/model-store', () => {
  const useModelStore = Object.assign((sel: (s: typeof store.state) => unknown) => sel(store.state), { getState: () => store.state })
  return { environmentModels: (s: unknown) => s, useModelStore }
})
vi.mock('../../settings-servers', () => ({ useSettingsEnvironment: () => ({ id: 'local', label: 'This Mac', isLocal: true, justAdded: false }) }))
vi.mock('../../use-environment-enterprise-policy', () => ({ useEnvironmentEnterprisePolicy: () => null }))
const prefs = vi.hoisted(() => ({
  state: {
    preferredModel: 'gone-model', engineDefaultModel: '', planModelSplitEnabled: false, planModeModel: '', implementModeModel: '',
    setPreferredModel: (_: string) => {}, setEngineDefaultModel: (_: string) => {}, setPlanModelSplitEnabled: (_: boolean) => {}, setPlanModeModel: (_: string) => {}, setImplementModeModel: (_: string) => {},
  },
}))
vi.mock('../../settings-target', () => ({
  useSettingsPreferences: (sel: (s: typeof prefs.state) => unknown) => sel(prefs.state),
  useSettingsTargetEnvironmentId: () => 'local',
}))
vi.mock('../../../../stores/use-allowed-models', () => ({ useAllowedModels: () => [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

const { ModelTiersSection } = await import('../models/ModelTiersSection')
const { DefaultModelsSection } = await import('../models/DefaultModelsSection')

const stub = {
  listModelTiers: vi.fn(async (): Promise<ModelTier[]> => []),
  setModelTier: vi.fn(async () => ({ ok: true })),
  removeModelTier: vi.fn(async () => ({ ok: true })),
  onModelTiersUpdated: vi.fn(() => () => {}),
  getDefaultProvider: vi.fn(async (): Promise<string> => ''),
  setDefaultProvider: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  onDefaultProviderUpdated: vi.fn(() => () => {}),
}

function select(h: Harness, label: string): HTMLSelectElement {
  const el = h.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!el) throw new Error(`no select ${label}`)
  return el
}
async function choose(h: Harness, label: string, value: string): Promise<void> {
  const el = select(h, label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}
const tierNames = (h: Harness): string[] => [...h.container.querySelectorAll('[role="listitem"]')].map((r) => r.querySelector('span span')?.textContent ?? '')

describe('Providers & models routing', () => {
  let h: Harness
  beforeEach(() => {
    for (const fn of Object.values(stub)) fn.mockClear()
    stub.listModelTiers.mockResolvedValue([])
    stub.getDefaultProvider.mockResolvedValue('')
    stub.setDefaultProvider.mockResolvedValue({ ok: true })
    ;(window as unknown as { ion: unknown }).ion = installFakeWire(stub)
    h = createHarness()
  })
  afterEach(() => { h.unmount(); document.body.querySelectorAll('[role="menu"]').forEach((m) => m.remove()) })

  describe('default provider', () => {
    it('reads the preference and lists only signed-in providers', async () => {
      stub.getDefaultProvider.mockResolvedValue('anthropic')
      await h.render(<ModelTiersSection />)
      expect(stub.getDefaultProvider).toHaveBeenCalledOnce()
      expect(select(h, 'Default provider').value).toBe('anthropic')
      expect([...select(h, 'Default provider').options].map((o) => o.value)).toEqual(['', 'anthropic', 'corp-gateway', 'test'])
      expect(select(h, 'Default provider').textContent).toContain('No preference')
    })

    it('saves a choice, clears it, and reverts when the engine refuses', async () => {
      await h.render(<ModelTiersSection />)
      await choose(h, 'Default provider', 'corp-gateway')
      expect(stub.setDefaultProvider).toHaveBeenLastCalledWith({ provider: 'corp-gateway' })
      await choose(h, 'Default provider', '')
      expect(stub.setDefaultProvider).toHaveBeenLastCalledWith({ provider: '' })
      stub.setDefaultProvider.mockResolvedValue({ ok: false, error: 'nope' })
      await choose(h, 'Default provider', 'anthropic')
      expect(select(h, 'Default provider').value).toBe('')
    })

    it('follows a broadcast snapshot and keeps a saved provider that is not signed in', async () => {
      await h.render(<ModelTiersSection />)
      stub.getDefaultProvider.mockResolvedValue('unauthed-provider')
      await act(async () => { emitOnChannel('ion:default-provider-updated'); await flush() })
      expect(select(h, 'Default provider').value).toBe('unauthed-provider')
      expect(select(h, 'Default provider').textContent).toContain('(unavailable)')
    })
  })

  describe('model tiers', () => {
    it('lists built-in tiers first and offers Remove only on a custom tier', async () => {
      stub.listModelTiers.mockResolvedValue([{ name: 'custom', model: 'model-a', fallbacks: [] }])
      await h.render(<ModelTiersSection />)
      expect(tierNames(h)).toEqual(['reasoning', 'standard', 'fast', 'workbench-sync', 'custom'])
      expect(h.container.querySelectorAll('[aria-label="Built-in tier"]')).toHaveLength(4)
      expect(select(h, 'workbench-sync primary model').textContent).toContain('Default (uses standard tier)')
      const menus = [...h.container.querySelectorAll<HTMLButtonElement>('button[aria-label="More actions"]')]
      expect(menus).toHaveLength(1)
      await act(async () => { menus[0].click(); await flush() })
      const remove = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((el) => el.textContent === 'Remove custom tier')
      await act(async () => { remove!.click(); await flush() })
      expect(stub.removeModelTier).toHaveBeenCalledWith({ name: 'custom' })
      expect(tierNames(h)).not.toContain('custom')
    })

    it('changes only the first fallback and keeps later engine fallbacks', async () => {
      stub.listModelTiers.mockResolvedValue([{ name: 'standard', model: 'model-a', fallbacks: ['model-b', 'engine-only'] }])
      await h.render(<ModelTiersSection />)
      await choose(h, 'standard fallback model', 'model-a')
      expect(stub.setModelTier).toHaveBeenLastCalledWith({ name: 'standard', model: 'model-a', fallbacks: ['model-a', 'engine-only'] })
      await choose(h, 'standard fallback model', '')
      expect(stub.setModelTier).toHaveBeenLastCalledWith({ name: 'standard', model: 'model-a', fallbacks: ['engine-only'] })
    })

    it('keeps a configured model the engine does not advertise visible as unavailable', async () => {
      stub.listModelTiers.mockResolvedValue([{ name: 'reasoning', model: 'gateway/primary', fallbacks: ['gateway/fallback'] }])
      await h.render(<ModelTiersSection />)
      expect(select(h, 'reasoning primary model').textContent).toContain('gateway/primary (unavailable)')
      expect(select(h, 'reasoning fallback model').textContent).toContain('gateway/fallback (unavailable)')
    })

    it('adds a custom tier from the side panel and refuses a taken name', async () => {
      await h.render(<ModelTiersSection />)
      await h.click('Add tier')
      const name = h.container.querySelector<HTMLInputElement>('input[aria-label="Tier name"]')!
      const type = (value: string): void => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value)
        name.dispatchEvent(new Event('input', { bubbles: true }))
      }
      act(() => type('Standard'))
      await choose(h, 'New tier primary model', 'model-a')
      expect(h.container.textContent).toContain('A tier with that name already exists.')
      expect((h.control('Add custom tier') as HTMLButtonElement).disabled).toBe(true)
      act(() => type('review'))
      await choose(h, 'New tier fallback model', 'model-b')
      await h.click('Add custom tier')
      expect(stub.setModelTier).toHaveBeenLastCalledWith({ name: 'review', model: 'model-a', fallbacks: ['model-b'] })
      expect(h.container.querySelector('input[aria-label="Tier name"]')).toBeNull()
    })
  })

  describe('default models', () => {
    it('shows a saved model the server does not offer as what it is', async () => {
      await h.render(<DefaultModelsSection />)
      const conversation = select(h, 'Default conversation model')
      expect(conversation.value).toBe('gone-model')
      expect(conversation.textContent).toContain('gone-model (not on this server)')
      expect(select(h, 'Default engine model').options[0].textContent).toBe('Default')
    })

    it('shows the planning and implementation models only while splitting is on', async () => {
      await h.render(<DefaultModelsSection />)
      expect(h.container.querySelector('select[aria-label="Planning model"]')).toBeNull()
      prefs.state.planModelSplitEnabled = true
      await h.render(<DefaultModelsSection />)
      expect(select(h, 'Planning model').options[0].textContent).toBe('Default (use conversation model)')
      expect(select(h, 'Implementation model')).toBeTruthy()
      prefs.state.planModelSplitEnabled = false
    })

    it('falls back to the allowed models as a segmented control before the server reports any', async () => {
      const saved = store.state.models
      store.state.models = []
      await h.render(<DefaultModelsSection />)
      expect(h.container.querySelector('select')).toBeNull()
      expect(h.container.querySelector('[role="radiogroup"][aria-label="Default conversation model"]')?.textContent).toBe('OpusSonnet')
      expect(h.container.querySelector('[role="radiogroup"][aria-label="Default engine model"]')?.textContent).toBe('DefaultOpusSonnet')
      store.state.models = saved
    })
  })
})
