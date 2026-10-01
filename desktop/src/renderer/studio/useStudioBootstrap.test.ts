// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({}) } }))
const modelSync = vi.hoisted(() => ({ listener: null as null | ((models: unknown[]) => void) }))
vi.mock('@ion/server/store/model-store', () => ({
  setupModelSync: vi.fn(),
  onLocalModelsFetched: (listener: (models: unknown[]) => void) => { modelSync.listener = listener; return () => {} },
}))
const normalizeModelPreferences = vi.hoisted(() => vi.fn())
vi.mock('../preferences', () => ({ usePreferencesStore: { getState: () => ({ normalizeModelPreferences }) } }))
vi.mock('../hooks/useResourceBootstrap', () => ({ bootstrapResources: vi.fn() }))
vi.mock('../startup-report', () => ({ reportStartup: vi.fn() }))
vi.mock('./surface/surface-store', () => ({ useSurfaceStore: { getState: () => ({ hydrate: vi.fn() }) } }))
vi.mock('../rendererLogger', () => ({ rError: vi.fn() }))
vi.mock('../preferences-bootstrap', () => ({ bootstrapPreferencesReady: vi.fn(() => Promise.resolve()) }))
vi.mock('./connection/registry', () => ({ registry: { boot: vi.fn() } }))
vi.mock('./connection/environment-availability', () => ({ environmentAvailability: { boot: vi.fn() } }))

import { useStudioBootstrap } from './useStudioBootstrap'
import { registry } from './connection/registry'
import { environmentAvailability } from './connection/environment-availability'

function renderBootstrapHook(layoutHydrated: boolean) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  function Harness({ hydrated }: { hydrated: boolean }) {
    useStudioBootstrap(hydrated)
    return null
  }
  act(() => { root.render(React.createElement(Harness, { hydrated: layoutHydrated })) })
  return {
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

describe('useStudioBootstrap connection boot', () => {
  // Regression for the actual root cause of the reported "~30 second page
  // load" symptom (2026-09-16), separate from the reconnect-loop and
  // offline-retry fixes: `useStudioLayout`'s persisted-layout read is a
  // bridged call that can only resolve once the registry has opened the
  // studio-wire connection, but this hook's boot of that same registry used
  // to be gated behind `layoutHydrated` -- exactly the value that call sets.
  // Every fresh browser Studio load paid the bridged call's full 30s
  // timeout before layout hydration (and therefore the registry boot)
  // could proceed. Confirmed live: `studio.getSettings`, `settings.load`,
  // and `presence.focus` all timed out simultaneously at the 30000ms mark,
  // immediately followed by the registry's first ever `connecting` phase.
  it('boots the registry and supervisor even when layoutHydrated is false', () => {
    const h = renderBootstrapHook(false)
    try {
      expect(registry.boot).toHaveBeenCalledTimes(1)
      expect(environmentAvailability.boot).toHaveBeenCalledTimes(1)
    } finally {
      h.unmount()
    }
  })
})

describe('useStudioBootstrap model preferences', () => {
  // The model store only fetches. This window's preference store rewrites a
  // retired model id and saves it over the wire; the server's own preference
  // writer is a stub that throws in the renderer.
  it('normalizes this window\'s preferences against every fresh local catalog', async () => {
    const h = renderBootstrapHook(true)
    try {
      expect(modelSync.listener).not.toBeNull()
      const models = [{ id: 'claude-sonnet-5', providerId: 'corp-gateway' }]
      modelSync.listener!(models)
      await act(async () => { await Promise.resolve() })
      expect(normalizeModelPreferences).toHaveBeenCalledWith(models)
    } finally {
      h.unmount()
    }
  })
})
