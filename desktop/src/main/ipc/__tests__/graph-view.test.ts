import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, getConfig, subscribe, unsubscribe, watchProject, unwatchProject } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getConfig: vi.fn(() => ({ corpusRoots: [] })),
  subscribe: vi.fn(async () => ({ revision: 1, roots: [], documents: [] })),
  unsubscribe: vi.fn(),
  watchProject: vi.fn(),
  unwatchProject: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: vi.fn((path: unknown) => typeof path === 'string' && path.startsWith('/')) }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../../settings-store', () => ({ readSettings: vi.fn(() => ({})) }))
vi.mock('../../settings-broadcast', () => ({ persistAndBroadcastSettings: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../graph-view/config-store', () => ({
  getGraphViewConfig: getConfig,
  invalidateAndBroadcastAll: vi.fn(),
  watchProject,
  unwatchProject,
}))
vi.mock('../../graph-view/config-resolve', () => ({ resolveGraphViewConfig: vi.fn(() => ({ corpusRoots: [] })) }))
vi.mock('../../graph-view/corpus-store', () => ({ subscribeCorpus: subscribe, unsubscribeCorpus: unsubscribe }))
vi.mock('../../../shared/graph-view-types', () => ({
  GRAPH_VIEW_PROJECT_FIELDS: [],
  isGraphViewAvailable: vi.fn(() => false),
}))

import { IPC } from '../../../shared/types-ipc'
import { registerGraphViewIpc } from '../graph-view'

function invoke(channel: string, payload: unknown): Promise<unknown> {
  return handlers.get(channel)!({ sender: { id: 1 } }, payload) as Promise<unknown>
}

describe('Graph View IPC envelope validation', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerGraphViewIpc()
  })

  it('rejects malformed envelopes without destructuring or calling project services', async () => {
    await expect(invoke(IPC.GRAPH_VIEW_GET_CONFIG, null)).resolves.toMatchObject({ corpusRoots: [] })
    await expect(invoke(IPC.GRAPH_VIEW_GET_CONFIG, { projectPath: 42 })).resolves.toMatchObject({ corpusRoots: [] })
    await expect(invoke(IPC.GRAPH_CORPUS_SUBSCRIBE, undefined)).resolves.toEqual({ revision: 0, roots: [], documents: [] })
    await expect(invoke(IPC.GRAPH_CORPUS_UNSUBSCRIBE, 'not-an-envelope')).resolves.toEqual({ ok: true })
    expect(getConfig).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('requires a patch object for user configuration', async () => {
    await expect(invoke(IPC.GRAPH_VIEW_SET_USER_CONFIG, null)).resolves.toEqual({ ok: false, error: 'Patch must be an object' })
  })
})

 describe('Graph View corpus IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerGraphViewIpc()
  })

  it('passes a valid project envelope to corpus subscribe and unsubscribe', async () => {
    await invoke(IPC.GRAPH_CORPUS_SUBSCRIBE, { projectPath: '/project' })
    await invoke(IPC.GRAPH_CORPUS_UNSUBSCRIBE, { projectPath: '/project' })
    expect(subscribe).toHaveBeenCalledWith('/project')
    expect(unsubscribe).toHaveBeenCalledWith('/project')
  })
})
