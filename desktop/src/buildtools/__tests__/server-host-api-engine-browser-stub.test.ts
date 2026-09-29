/**
 * The model/provider reads in the renderer's build-time replacement for
 * `server/src/store/host-api-engine.ts` must reach the server, not answer
 * empty.
 *
 * Regression pin. `listModels()` used to `Promise.resolve({models: [], providers: []})`.
 * Both renderer targets build through this stub -- the Electron Studio window
 * AND a browser tab -- so BOTH rendered an empty provider list in the AI
 * Models settings category and an empty model picker, with nothing logged:
 * `model-store.fetchModels` stored the empty answer as a success. Reverting
 * either function to a resolved empty value turns this test red.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls: Array<{ environmentId: string; name: string; args: unknown[] }> = []
vi.mock('../../renderer/host/host-instance', () => ({
  action: (environmentId: string, name: string, args: unknown[] = []) => {
    calls.push({ environmentId, name, args })
    return Promise.resolve({ models: [{ id: 'm1' }], providers: [{ id: 'p1', hasAuth: true }] })
  },
}))

import { listModels, resolveModelTier, providerLoginCancel } from '../server-host-api-engine-browser-stub'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

beforeEach(() => { calls.length = 0 })

describe('browser host-api-engine stub: model and provider reads', () => {
  it('answers listModels from the server over the studio wire, not with an empty list', async () => {
    const result = await listModels()
    expect(calls).toEqual([{ environmentId: LOCAL_ENVIRONMENT_ID, name: 'model.list', args: [] }])
    expect(result.providers).toHaveLength(1)
    expect(result.models).toHaveLength(1)
  })

  it('forwards resolveModelTier and providerLoginCancel with their arguments', async () => {
    await resolveModelTier('workbench')
    await providerLoginCancel('anthropic')
    // `provider.loginCancel` is one of the named-payload actions: the server
    // reads `payload.provider` (server/src/engine/provider-api.ts), so the
    // stub must pack an object, not a bare string.
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ['model.resolveTier', ['workbench']],
      ['provider.loginCancel', [{ provider: 'anthropic' }]],
    ])
  })
})
