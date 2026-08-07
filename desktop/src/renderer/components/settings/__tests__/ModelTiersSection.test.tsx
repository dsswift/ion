// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../../stores/model-store', () => ({
  useModelStore: (selector: (state: { models: Array<{ id: string; providerId: string }> }) => unknown) => selector({ models: [{ id: 'model-a', providerId: 'test' }, { id: 'model-b', providerId: 'test' }, { id: 'claude-opus-5', providerId: 'dci-marketing' }] }),
}))
vi.mock('../../../stores/model-labels', () => ({ getModelDisplayLabel: (id: string) => id }))

import { ModelTiersSection } from '../ModelTiersSection'
import type { ModelTier } from '../../../../shared/types-model-tiers'

const ion = {
  listModelTiers: vi.fn(async (): Promise<ModelTier[]> => []),
  setModelTier: vi.fn(async () => ({ ok: true })),
  removeModelTier: vi.fn(async () => ({ ok: true })),
  onModelTiersUpdated: vi.fn(() => () => {}),
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  ion.listModelTiers.mockResolvedValue([])
  ;(window as unknown as { ion: typeof ion }).ion = ion
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ModelTiersSection />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function select(label: string): HTMLSelectElement {
  const element = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement | null
  if (!element) throw new Error(`Missing select ${label}`)
  return element
}

async function choose(label: string, value: string): Promise<void> {
  const element = select(label)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ModelTiersSection', () => {
  it('renders built-in tiers first with labels and without remove controls', async () => {
    ion.listModelTiers.mockResolvedValue([{ name: 'custom', model: 'model-a', fallbacks: [] }])
    await render()

    const labels = Array.from(container.querySelectorAll('strong')).map((element) => element.textContent)
    expect(labels).toEqual(['reasoning', 'standard', 'fast', 'custom'])
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0)
    expect(container.querySelector('[aria-label="Remove reasoning tier"]')).toBeNull()
    expect(container.querySelector('[aria-label="Remove standard tier"]')).toBeNull()
    expect(container.querySelector('[aria-label="Remove fast tier"]')).toBeNull()
    expect(container.querySelector('[aria-label="Remove custom tier"]')).not.toBeNull()
  })

  it('changes only first fallback and preserves later engine fallbacks', async () => {
    ion.listModelTiers.mockResolvedValue([{ name: 'standard', model: 'model-a', fallbacks: ['model-b', 'engine-only'] }])
    await render()

    await choose('standard fallback model', 'model-a')
    expect(ion.setModelTier).toHaveBeenLastCalledWith({ name: 'standard', model: 'model-a', fallbacks: ['model-a', 'engine-only'] })

    await choose('standard fallback model', '')
    expect(ion.setModelTier).toHaveBeenLastCalledWith({ name: 'standard', model: 'model-a', fallbacks: ['engine-only'] })
  })

  it('keeps a qualified tier ID unavailable when engine does not advertise that alias', async () => {
    ion.listModelTiers.mockResolvedValue([{ name: 'reasoning', model: 'dci-marketing/claude-opus-5', fallbacks: [] }])
    await render()

    expect(select('reasoning primary model').textContent).toContain('dci-marketing/claude-opus-5 (unavailable)')
  })

  it('keeps genuinely unavailable configured models visible in both columns', async () => {
    ion.listModelTiers.mockResolvedValue([{ name: 'reasoning', model: 'gateway/primary', fallbacks: ['gateway/fallback'] }])
    await render()

    expect(select('reasoning primary model').textContent).toContain('gateway/primary (unavailable)')
    expect(select('reasoning fallback model').textContent).toContain('gateway/fallback (unavailable)')
  })

  it('creates and removes custom rows with one optional fallback', async () => {
    await render()
    const name = container.querySelector('input[aria-label="Tier name"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(name, 'review')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await choose('New tier primary model', 'model-a')
    await choose('New tier fallback model', 'model-b')
    const add = container.querySelector('[aria-label="Add custom tier"]') as HTMLButtonElement
    await act(async () => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(ion.setModelTier).toHaveBeenLastCalledWith({ name: 'review', model: 'model-a', fallbacks: ['model-b'] })
  })
})
