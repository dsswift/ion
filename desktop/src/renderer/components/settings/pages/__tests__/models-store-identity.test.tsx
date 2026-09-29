// @vitest-environment jsdom
/**
 * Providers & models against the REAL model store on STOCK zustand, which is
 * what the browser Studio bundle ships: the server image installs with
 * `--ignore-scripts`, so desktop's postinstall zustand patch never runs
 * there. Stock zustand 5 compares a selector's result by identity, so a
 * selector returning a fresh object on every read re-renders forever and
 * React aborts with "Maximum update depth exceeded" (#185). The page's other
 * tests stub `useModelStore` with a plain function and cannot see this.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import type { StateCreator, StoreApi } from 'zustand/vanilla'
import { useModelStore } from '@ion/server/store/model-store'
import { createHarness, type Harness } from './page-harness'

// zustand 5.0.15's own useStore, before desktop/scripts/patch-zustand.js.
vi.mock('zustand', async () => {
  const React = await import('react')
  const { createStore } = await import('zustand/vanilla')
  type Selector = (state: unknown) => unknown
  const identity: Selector = (arg) => arg
  function useStore(api: StoreApi<unknown>, selector: Selector = identity): unknown {
    return React.useSyncExternalStore(
      api.subscribe,
      React.useCallback(() => selector(api.getState()), [api, selector]),
      React.useCallback(() => selector(api.getInitialState()), [api, selector]),
    )
  }
  const createImpl = (createState: StateCreator<unknown>) => {
    const api = createStore(createState)
    return Object.assign((selector?: Selector) => useStore(api, selector), api)
  }
  const create = (createState?: StateCreator<unknown>) => (createState ? createImpl(createState) : createImpl)
  return { create, createStore, useStore }
})

vi.mock('../../settings-target', () => ({
  useSettingsPreferences: (sel: (s: Record<string, unknown>) => unknown) => sel({
    preferredModel: '', engineDefaultModel: '', planModelSplitEnabled: false, planModeModel: '', implementModeModel: '',
    setPreferredModel: () => {}, setEngineDefaultModel: () => {}, setPlanModelSplitEnabled: () => {}, setPlanModeModel: () => {}, setImplementModeModel: () => {},
  }),
  useSettingsTargetEnvironmentId: () => 'local',
}))
vi.mock('../../use-environment-enterprise-policy', () => ({ useEnvironmentEnterprisePolicy: () => null }))
vi.mock('../../../../stores/use-allowed-models', () => ({ useAllowedModels: () => [] }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

const { DefaultModelsSection } = await import('../models/DefaultModelsSection')

// A browser client on a server with one keyed provider among many unkeyed ones.
const providers = [
  { id: 'dci-marketing', hasAuth: true },
  { id: 'anthropic', hasAuth: false },
  { id: 'openai', hasAuth: false },
] as ProviderEntry[]
const models = [
  { id: 'claude-sonnet-5', providerId: 'dci-marketing' },
  { id: 'gpt-5', providerId: 'openai' },
] as ModelEntry[]

describe('Providers & models on the real model store, stock zustand', () => {
  let h: Harness
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    // Already fetched, so the section's mount effect does not reach the wire.
    useModelStore.setState({ models, providers, loading: false, lastFetched: 1 })
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    h = createHarness()
  })
  afterEach(() => { h.unmount(); errors.mockRestore() })

  it('renders the default model pickers for the local server without an update loop', async () => {
    await h.render(<DefaultModelsSection />)
    expect(h.container.querySelector('select[aria-label="Default conversation model"]')?.textContent).toContain('claude-sonnet-5')
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/Maximum update depth|getSnapshot should be cached/)
  })
})
