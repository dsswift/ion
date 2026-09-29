// @vitest-environment jsdom
/**
 * The graph corpus slice on a host that reports only the wire-routed
 * capabilities -- a browser Studio client. The slice used to gate every
 * `host.shell.graph*` call on an Electron-only `graphDirect` capability and
 * report the Graph View unavailable in a browser; the reads are the
 * `graphView.*` studio_actions now, so the slice makes them on every host.
 * `host-instance` is mocked directly because it caches its resolved host
 * class for the module's lifetime, and the capability list here is a real
 * BrowserStudioHost set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  graphViewGetConfig,
  graphCorpusSubscribe,
  graphCorpusUnsubscribe,
  onGraphCorpusDelta,
  onGraphViewConfigChanged,
  capabilities,
} = vi.hoisted(() => ({
  graphViewGetConfig: vi.fn(),
  graphCorpusSubscribe: vi.fn(),
  graphCorpusUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
  onGraphCorpusDelta: vi.fn(() => () => undefined),
  onGraphViewConfigChanged: vi.fn(() => () => undefined),
  capabilities: vi.fn<() => string[]>(() => ['terminal', 'git', 'files', 'questions', 'graph']),
}))

vi.mock('../../host/host-instance', () => ({
  host: {
    capabilities,
    shell: {
      graphViewGetConfig,
      graphCorpusSubscribe,
      graphCorpusUnsubscribe,
      onGraphCorpusDelta,
      onGraphViewConfigChanged,
    },
  },
}))

import { useGraphStore } from './graph-store'
import { clearAllSessions } from './session-park'
import { GRAPH_VIEW_DEFAULTS, type GraphViewConfig } from '@ion/shared/graph-view-types'

function config(overrides?: Partial<GraphViewConfig>): GraphViewConfig {
  return {
    corpusRoots: [{ path: '/repo/docs' }],
    identityField: GRAPH_VIEW_DEFAULTS.identityField,
    labelField: GRAPH_VIEW_DEFAULTS.labelField,
    tagField: GRAPH_VIEW_DEFAULTS.tagField,
    groupFields: GRAPH_VIEW_DEFAULTS.groupFields,
    edgeFields: GRAPH_VIEW_DEFAULTS.edgeFields,
    hoverFields: GRAPH_VIEW_DEFAULTS.hoverFields,
    curatedFields: [],
    promotedFields: [],
    savedViews: [],
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: GRAPH_VIEW_DEFAULTS.sectionNodes,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
    ...overrides,
  }
}

beforeEach(() => {
  graphViewGetConfig.mockClear()
  graphCorpusSubscribe.mockClear()
  graphCorpusUnsubscribe.mockClear()
  onGraphCorpusDelta.mockClear()
  onGraphViewConfigChanged.mockClear()
  clearAllSessions()
})

describe('graph corpus slice on a browser Studio client', () => {
  it('checkAvailability reads the config over the wire', async () => {
    graphViewGetConfig.mockResolvedValue(config())
    await useGraphStore.getState().checkAvailability('/repo')
    expect(graphViewGetConfig).toHaveBeenCalledWith('/repo')
    expect(useGraphStore.getState().available).toBe(true)
  })

  it('init reads the config, subscribes to the corpus, and attaches both listeners', async () => {
    graphViewGetConfig.mockResolvedValue(config())
    graphCorpusSubscribe.mockResolvedValue({ revision: 1, roots: [{ path: '/repo/docs', exists: true, documentCount: 0 }], documents: [] })
    await useGraphStore.getState().init('/repo')
    expect(graphViewGetConfig).toHaveBeenCalledWith('/repo')
    expect(graphCorpusSubscribe).toHaveBeenCalledWith('/repo')
    expect(onGraphCorpusDelta).toHaveBeenCalledTimes(1)
    expect(onGraphViewConfigChanged).toHaveBeenCalledTimes(1)
    expect(useGraphStore.getState().available).toBe(true)
    expect(useGraphStore.getState().projectPath).toBe('/repo')
  })

  it('closeSession releases the corpus reference it took', async () => {
    graphViewGetConfig.mockResolvedValue(config())
    graphCorpusSubscribe.mockResolvedValue({ revision: 1, roots: [{ path: '/repo/docs', exists: true, documentCount: 0 }], documents: [] })
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().closeSession('/repo')
    expect(graphCorpusUnsubscribe).toHaveBeenCalledWith('/repo')
  })

  it('dispose does not release anything for a project that never subscribed', () => {
    useGraphStore.setState({ projectPath: '/repo', model: null })
    useGraphStore.getState().dispose()
    // No model to park, so the reference (if any) is handed back now.
    expect(graphCorpusUnsubscribe).toHaveBeenCalledWith('/repo')
  })
})
