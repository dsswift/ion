// @vitest-environment jsdom
/**
 * useAllowedModels — local reads through the legacy preferences-store field
 * (D-011, unchanged); an explicit remote environmentId reads the connection
 * policy store instead, so a remote allowedModels narrows only that
 * environment's picker and never the local one, and vice versa (spec 14
 * pinned behaviors).
 */
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let localAllowedModels: string[] | undefined
vi.mock('../preferences', () => ({
  usePreferencesStore: (selector: (s: { enterprisePolicy: { allowedModels?: string[] } | null }) => unknown) =>
    selector({ enterprisePolicy: localAllowedModels ? { allowedModels: localAllowedModels } : null }),
}))
vi.mock('@ion/server/store/model-labels', () => ({
  getFilteredModels: (allowed: string[] | undefined) => (allowed && allowed.length > 0 ? allowed : ['model-a', 'model-b', 'model-c']),
}))

import { policyStore } from '../studio/connection/policy-store'
import { useAllowedModels } from './use-allowed-models'

function Probe({ environmentId }: { environmentId?: string }): React.JSX.Element {
  const models = useAllowedModels(environmentId)
  return <div data-testid="models">{models.join(',')}</div>
}

describe('useAllowedModels', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localAllowedModels = undefined
    policyStore._resetForTest()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('defaults to the local environment, reading the legacy preferences-store field', () => {
    localAllowedModels = ['local-only-model']
    act(() => root.render(<Probe />))
    expect(container.querySelector('[data-testid="models"]')?.textContent).toBe('local-only-model')
  })

  it('a remote allowedModels does not narrow the local tab', () => {
    localAllowedModels = undefined
    policyStore.set('env-b', { allowedModels: ['remote-only-model'] })
    act(() => root.render(<Probe />))
    expect(container.querySelector('[data-testid="models"]')?.textContent).toBe('model-a,model-b,model-c')
  })

  it('the local allowedModels does not narrow a remote tab', () => {
    localAllowedModels = ['local-only-model']
    policyStore.set('env-b', { allowedModels: [] })
    act(() => root.render(<Probe environmentId="env-b" />))
    expect(container.querySelector('[data-testid="models"]')?.textContent).toBe('model-a,model-b,model-c')
  })

  it('reads a specific remote environment’s own allowedModels', () => {
    policyStore.set('env-b', { allowedModels: ['env-b-model'] })
    policyStore.set('env-c', { allowedModels: ['env-c-model'] })
    act(() => root.render(<Probe environmentId="env-b" />))
    expect(container.querySelector('[data-testid="models"]')?.textContent).toBe('env-b-model')
  })
})
