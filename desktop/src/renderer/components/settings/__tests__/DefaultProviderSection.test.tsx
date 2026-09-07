// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../../stores/model-store', () => ({
  useModelStore: (selector: (state: { providers: Array<{ id: string; hasAuth: boolean }> }) => unknown) => selector({
    providers: [
      { id: 'anthropic', hasAuth: true },
      { id: 'dci-marketing', hasAuth: true },
      { id: 'unauthed-provider', hasAuth: false },
    ],
  }),
}))

import { DefaultProviderSection } from '../DefaultProviderSection'

const ion = {
  getDefaultProvider: vi.fn(async (): Promise<string> => ''),
  setDefaultProvider: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  onDefaultProviderUpdated: vi.fn((_callback: () => void) => () => {}),
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  ion.getDefaultProvider.mockResolvedValue('')
  ion.setDefaultProvider.mockResolvedValue({ ok: true })
  ion.onDefaultProviderUpdated.mockImplementation(() => () => {})
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
    root.render(<DefaultProviderSection />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function select(): HTMLSelectElement {
  const element = container.querySelector('select[aria-label="Default provider"]') as HTMLSelectElement | null
  if (!element) throw new Error('Missing default provider select')
  return element
}

async function choose(value: string): Promise<void> {
  const element = select()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('DefaultProviderSection', () => {
  it('reads the preference on mount and lists only authed providers', async () => {
    ion.getDefaultProvider.mockResolvedValue('anthropic')
    await render()

    expect(ion.getDefaultProvider).toHaveBeenCalledOnce()
    expect(select().value).toBe('anthropic')
    const values = Array.from(select().querySelectorAll('option')).map((option) => option.value)
    expect(values).toEqual(['', 'anthropic', 'dci-marketing'])
    expect(select().textContent).toContain('No preference')
  })

  it('persists a chosen provider', async () => {
    await render()
    await choose('dci-marketing')

    expect(ion.setDefaultProvider).toHaveBeenLastCalledWith('dci-marketing')
    expect(select().value).toBe('dci-marketing')
  })

  it('clears the preference with the empty option', async () => {
    ion.getDefaultProvider.mockResolvedValue('dci-marketing')
    await render()
    await choose('')

    expect(ion.setDefaultProvider).toHaveBeenLastCalledWith('')
    expect(select().value).toBe('')
  })

  it('reverts the control when the engine refuses the write', async () => {
    ion.getDefaultProvider.mockResolvedValue('anthropic')
    ion.setDefaultProvider.mockResolvedValue({ ok: false, error: 'nope' })
    await render()
    await choose('dci-marketing')

    expect(select().value).toBe('anthropic')
  })

  it('reflects a broadcast snapshot from another window', async () => {
    let notify = (): void => {}
    ion.onDefaultProviderUpdated.mockImplementation((callback: () => void) => {
      notify = callback
      return () => {}
    })
    await render()
    expect(select().value).toBe('')

    ion.getDefaultProvider.mockResolvedValue('dci-marketing')
    await act(async () => {
      notify()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(select().value).toBe('dci-marketing')
  })

  it('keeps a persisted but unauthed provider selectable', async () => {
    ion.getDefaultProvider.mockResolvedValue('unauthed-provider')
    await render()

    expect(select().value).toBe('unauthed-provider')
    expect(select().textContent).toContain('(unavailable)')
  })
})
