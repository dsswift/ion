// @vitest-environment jsdom
/**
 * environment-label-cache — a badge mounted before an environment joins the
 * catalog must pick up that environment's label once the catalog is written,
 * not keep showing its id.
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REMOTE_ID = '00000000-0000-4000-8000-000000000001'
let environments: unknown[] = []

const hostMock = {
  deviceSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({ environments })),
  setDeviceSetting: vi.fn(async (_key: string, value: unknown) => { environments = value as unknown[] }),
  capabilities: vi.fn(() => ['local']),
}

vi.mock('../../host/host-instance', () => ({
  get host() { return hostMock },
}))
vi.mock('../connection/policy-store', () => ({
  policyStore: { devicePolicy: () => null },
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))

describe('environment-label-cache', () => {
  it('re-resolves a mounted label when the catalog gains the environment', async () => {
    const { useEnvironmentLabel } = await import('./environment-label-cache')
    const { addToCatalog } = await import('../connection/catalog')

    let label: string | null = null
    function Probe(): null {
      label = useEnvironmentLabel(REMOTE_ID)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(<Probe />) })
    expect(label).toBe(REMOTE_ID)

    await act(async () => {
      await addToCatalog({ kind: 'paired', label: 'example-host', url: 'http://192.0.2.1:7331', credentialRef: REMOTE_ID, via: 'lan', environmentId: REMOTE_ID })
    })
    expect(label).toBe('example-host')

    act(() => { root.unmount() })
  })
})
