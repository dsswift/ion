/**
 * Pins the `graphView.*` surface that replaced the desktop's graph-view IPC:
 * envelope validation, the settings merge, and that a corpus reference is
 * charged to the calling connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ corpusRoots: [] })),
  invalidateAndBroadcastAll: vi.fn(),
  readSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  persistAndBroadcastSettings: vi.fn(),
  subscribeCorpusFor: vi.fn(async () => ({ revision: 1, roots: [], documents: [] })),
  unsubscribeCorpusFor: vi.fn(),
}))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: (p: unknown) => typeof p === 'string' && p.startsWith('/') }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../persistence/settings-store', () => ({ readSettings: deps.readSettings }))
vi.mock('../../settings-broadcast', () => ({ persistAndBroadcastSettings: deps.persistAndBroadcastSettings }))
vi.mock('../../graph-view/config-store', () => ({ getGraphViewConfig: deps.getConfig, invalidateAndBroadcastAll: deps.invalidateAndBroadcastAll }))
vi.mock('../../graph-view/config-resolve', () => ({ resolveGraphViewConfig: () => ({ corpusRoots: [], shaped: 'default' }) }))
vi.mock('../../graph-view/corpus-subscriptions', () => ({ subscribeCorpusFor: deps.subscribeCorpusFor, unsubscribeCorpusFor: deps.unsubscribeCorpusFor }))
vi.mock('@ion/shared/graph-view-types', () => ({ GRAPH_VIEW_PROJECT_FIELDS: ['savedViews', 'corpusRoots'], isGraphViewAvailable: () => false }))

import { GRAPH_VIEW_ACTIONS } from '../graph-view-actions'
import type { Connection } from '../connection'

const conn = { id: 'conn-1', scopes: ['conversations:operate'] } as unknown as Connection
const run = (name: string, ...args: unknown[]) => GRAPH_VIEW_ACTIONS[name].handler(conn, args)

beforeEach(() => { for (const fn of Object.values(deps)) fn.mockClear(); deps.readSettings.mockReturnValue({}) })

describe('GRAPH_VIEW_ACTIONS', () => {
  it('getConfig answers the default shape for an invalid path without touching the config store', async () => {
    expect(await run('graphView.getConfig', 'relative/path')).toEqual({ ok: true, value: { corpusRoots: [], shaped: 'default' } })
    expect(await run('graphView.getConfig', { projectPath: '/repo' })).toEqual({ ok: true, value: { corpusRoots: [], shaped: 'default' } })
    expect(deps.getConfig).not.toHaveBeenCalled()
    expect(await run('graphView.getConfig', '/repo')).toEqual({ ok: true, value: { corpusRoots: [] } })
    expect(deps.getConfig).toHaveBeenCalledWith('/repo')
  })

  it('setUserConfig requires an object patch of allowed keys and merges it under desktop.graphView', async () => {
    expect(await run('graphView.setUserConfig', 'nope')).toEqual({ ok: true, value: { ok: false, error: 'Patch must be an object' } })
    expect(await run('graphView.setUserConfig', { evil: 1 })).toEqual({ ok: true, value: { ok: false, error: 'Disallowed keys: evil' } })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()

    deps.readSettings.mockReturnValue({ theme: 'dark', desktop: { zoom: 1, graphView: { corpusRoots: ['/x'] } } })
    expect(await run('graphView.setUserConfig', { savedViews: [{ id: 'v' }] })).toEqual({ ok: true, value: { ok: true } })
    expect(deps.persistAndBroadcastSettings).toHaveBeenCalledWith(
      { theme: 'dark', desktop: { zoom: 1, graphView: { corpusRoots: ['/x'], savedViews: [{ id: 'v' }] } } },
      { theme: 'dark', desktop: { zoom: 1, graphView: { corpusRoots: ['/x'] } } },
    )
    expect(deps.invalidateAndBroadcastAll).toHaveBeenCalledTimes(1)
  })

  it('setUserConfig reports a failed write instead of throwing', async () => {
    deps.persistAndBroadcastSettings.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(await run('graphView.setUserConfig', { savedViews: [] })).toEqual({ ok: true, value: { ok: false, error: 'Error: disk full' } })
    expect(deps.invalidateAndBroadcastAll).not.toHaveBeenCalled()
  })

  it('corpusSubscribe charges the reference to the calling connection; an invalid path gets the empty snapshot', async () => {
    expect(await run('graphView.corpusSubscribe', 'bad')).toEqual({ ok: true, value: { revision: 0, roots: [], documents: [] } })
    expect(deps.subscribeCorpusFor).not.toHaveBeenCalled()
    expect(await run('graphView.corpusSubscribe', '/repo')).toEqual({ ok: true, value: { revision: 1, roots: [], documents: [] } })
    expect(deps.subscribeCorpusFor).toHaveBeenCalledWith('conn-1', '/repo')
  })

  it('corpusUnsubscribe releases the calling connection\'s reference', async () => {
    expect(await run('graphView.corpusUnsubscribe', '/repo')).toEqual({ ok: true, value: { ok: true } })
    expect(deps.unsubscribeCorpusFor).toHaveBeenCalledWith('conn-1', '/repo')
    expect(await run('graphView.corpusUnsubscribe', 42)).toEqual({ ok: true, value: { ok: true } })
    expect(deps.unsubscribeCorpusFor).toHaveBeenCalledTimes(1)
  })

  it('reads are conversations:read and the settings write is conversations:operate', () => {
    expect(GRAPH_VIEW_ACTIONS['graphView.getConfig'].requiredScope).toBe('conversations:read')
    expect(GRAPH_VIEW_ACTIONS['graphView.corpusSubscribe'].requiredScope).toBe('conversations:read')
    expect(GRAPH_VIEW_ACTIONS['graphView.setUserConfig'].requiredScope).toBe('conversations:operate')
  })
})
