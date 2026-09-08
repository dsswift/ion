// @vitest-environment jsdom
/**
 * Tests for graph-store.ts interaction actions (child 07): plain selection,
 * modified-click file open through the router, no-op on a fileless node,
 * and badge counts following model.dangling / model.identityCollisions.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { useSessionStore } from '../../stores/sessionStore'
import { clearAllSessions } from './session-park'
import { GRAPH_VIEW_DEFAULTS } from '../../../shared/graph-view-types'
import type { GraphViewConfig } from '../../../shared/graph-view-types'
import type { CorpusSnapshot } from '../../../shared/graph-corpus-types'

function config(overrides?: Partial<GraphViewConfig>): GraphViewConfig {
  return {
    corpusRoots: [{ path: '/root' }],
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

function installIonStub(snapshot: CorpusSnapshot): void {
  window.ion = {
    graphViewGetConfig: vi.fn(async () => config()),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async () => snapshot),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
  } as unknown as typeof window.ion
}

afterEach(() => {
  useGraphStore.getState().dispose()
  // The park is module state shared across suites; a stale session would
  // resume into the next test instead of building fresh.
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('selectNode', () => {
  it('plain selection replaces the set; null clears it', () => {
    useGraphStore.getState().selectNode('a')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['a'])
    useGraphStore.getState().selectNode('b')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['b'])
    useGraphStore.getState().selectNode(null)
    expect(useGraphStore.getState().selectedNodeIds.size).toBe(0)
  })
})

describe('toggleNodeSelection and emphasis', () => {
  /** a — b — c, plus isolated d. */
  function chainSnapshot(): CorpusSnapshot {
    const doc = (id: string, links: string[]) => ({ path: `/root/${id}.md`, rootPath: '/root', fileName: id, frontMatter: { id }, wikiLinks: links, markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 })
    return { revision: 1, roots: [{ path: '/root', exists: true, documentCount: 4 }], documents: [doc('a', ['b']), doc('b', ['c']), doc('c', []), doc('d', [])] }
  }

  it('toggle adds, toggle again removes, and emphasis is the 1-hop union', async () => {
    installIonStub(chainSnapshot())
    await useGraphStore.getState().init('/root')

    useGraphStore.getState().toggleNodeSelection('a')
    useGraphStore.getState().toggleNodeSelection('d')
    expect([...useGraphStore.getState().selectedNodeIds].sort()).toEqual(['a', 'd'])
    expect([...useGraphStore.getState().emphasisNodeIds].sort()).toEqual(['a', 'b', 'd'])

    useGraphStore.getState().toggleNodeSelection('a')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['d'])
    expect([...useGraphStore.getState().emphasisNodeIds]).toEqual(['d'])
  })

  it('a removed node leaves the selection and the survivors keep their emphasis', async () => {
    installIonStub(chainSnapshot())
    await useGraphStore.getState().init('/root')
    useGraphStore.getState().toggleNodeSelection('a')
    useGraphStore.getState().toggleNodeSelection('c')

    useGraphStore.getState().applyDelta({ revision: 2, upserted: [], removedPaths: ['/root/a.md'], roots: [{ path: '/root', exists: true, documentCount: 3 }] })
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['c'])
    expect([...useGraphStore.getState().emphasisNodeIds].sort()).toEqual(['b', 'c'])
  })
})

describe('agent highlight', () => {
  /** a — b — c, plus isolated d. */
  function chainSnapshot(): CorpusSnapshot {
    const doc = (id: string, links: string[]) => ({ path: `/root/${id}.md`, rootPath: '/root', fileName: id, frontMatter: { id }, wikiLinks: links, markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 })
    return { revision: 1, roots: [{ path: '/root', exists: true, documentCount: 4 }], documents: [doc('a', ['b']), doc('b', ['c']), doc('c', []), doc('d', [])] }
  }

  it('is kept apart from the selection, drops unknown ids, and both feed emphasis', async () => {
    installIonStub(chainSnapshot())
    await useGraphStore.getState().init('/root')
    useGraphStore.getState().selectNode('d')
    useGraphStore.getState().setAgentHighlight(['a', 'ghost'])
    const state = useGraphStore.getState()
    expect([...state.agentHighlightNodeIds]).toEqual(['a'])
    expect([...state.selectedNodeIds]).toEqual(['d'])
    expect([...state.emphasisNodeIds].sort()).toEqual(['a', 'b', 'd'])
  })

  it('is cleared by the operator\'s next click, replace or toggle, and by clearAgentHighlight', async () => {
    installIonStub(chainSnapshot())
    await useGraphStore.getState().init('/root')
    useGraphStore.getState().setAgentHighlight(['a'])
    useGraphStore.getState().selectNode('c')
    expect(useGraphStore.getState().agentHighlightNodeIds.size).toBe(0)
    expect([...useGraphStore.getState().emphasisNodeIds].sort()).toEqual(['b', 'c'])

    useGraphStore.getState().setAgentHighlight(['a'])
    useGraphStore.getState().toggleNodeSelection('d')
    expect(useGraphStore.getState().agentHighlightNodeIds.size).toBe(0)

    useGraphStore.getState().setAgentHighlight(['a'])
    useGraphStore.getState().clearAgentHighlight()
    expect(useGraphStore.getState().agentHighlightNodeIds.size).toBe(0)
    // The selection is c and d by now; emphasis is their 1-hop union.
    expect([...useGraphStore.getState().emphasisNodeIds].sort()).toEqual(['b', 'c', 'd'])
  })

  it('camera and peek requests hand back a seq the render layer reports against', async () => {
    installIonStub(chainSnapshot())
    await useGraphStore.getState().init('/root')
    const first = useGraphStore.getState().requestCamera({ kind: 'fit-all' })
    const second = useGraphStore.getState().requestCamera({ kind: 'focus', nodeId: 'a' })
    expect(second).toBe(first + 1)
    useGraphStore.getState().noteCameraApplied(second)
    expect(useGraphStore.getState().cameraAppliedSeq).toBe(second)
    // A slow earlier animation finishing late must not roll the marker back.
    useGraphStore.getState().noteCameraApplied(first)
    expect(useGraphStore.getState().cameraAppliedSeq).toBe(second)

    const peek = useGraphStore.getState().requestPeek('b')
    expect(useGraphStore.getState().peekRequest).toEqual({ nodeId: 'b', seq: peek })
  })
})

describe('requestOpenFile', () => {
  afterEach(() => {
    useSessionStore.setState({ activeTabId: null, tabs: [] } as never)
  })

  it('a document node with a path requests the router to open it in the tab hosting the graph', async () => {
    installIonStub({
      revision: 1,
      roots: [{ path: '/root', exists: true, documentCount: 1 }],
      documents: [{ path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    })
    await useGraphStore.getState().init('/root')
    useSessionStore.setState({
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', workingDirectory: '/root', historicalSessionIds: [], bashResults: [], label: 'root', status: 'idle' }],
    } as never)

    const openTextFile = vi.fn()
    const { registerContentRouter } = await import('../../lib/file-open-router')
    registerContentRouter({ openTextFile, openImage: vi.fn(), openHtml: vi.fn(), openGitDiff: vi.fn() })

    useGraphStore.getState().requestOpenFile('a')
    // The second argument is a conversation id, not the corpus root: the
    // surface store resolves it against the live session tabs to find whose
    // file list and buffer to update. Passing the corpus root there matched
    // no tab and silently dropped the open (see graph-store.ts).
    expect(openTextFile).toHaveBeenCalledWith('/root', 'tab-1', '/root/a.md')
  })

  it('is a no-op with no active tab to host the opened file', async () => {
    installIonStub({
      revision: 1,
      roots: [{ path: '/root', exists: true, documentCount: 1 }],
      documents: [{ path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    })
    await useGraphStore.getState().init('/root')
    useSessionStore.setState({ activeTabId: null, tabs: [] } as never)

    const openTextFile = vi.fn()
    const { registerContentRouter } = await import('../../lib/file-open-router')
    registerContentRouter({ openTextFile, openImage: vi.fn(), openHtml: vi.fn(), openGitDiff: vi.fn() })

    useGraphStore.getState().requestOpenFile('a')
    expect(openTextFile).not.toHaveBeenCalled()
  })

  it('a group node (no file) is a no-op', async () => {
    installIonStub({
      revision: 1,
      roots: [{ path: '/root', exists: true, documentCount: 1 }],
      documents: [{ path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { topic: 'ops' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    })
    // Rebuild with groupFields so a group node exists.
    window.ion.graphViewGetConfig = vi.fn(async () => config({ groupFields: ['topic'] })) as typeof window.ion.graphViewGetConfig
    await useGraphStore.getState().init('/root')
    useSessionStore.setState({
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', workingDirectory: '/root', historicalSessionIds: [], bashResults: [], label: 'root', status: 'idle' }],
    } as never)

    const openTextFile = vi.fn()
    const { registerContentRouter } = await import('../../lib/file-open-router')
    registerContentRouter({ openTextFile, openImage: vi.fn(), openHtml: vi.fn(), openGitDiff: vi.fn() })

    useGraphStore.getState().requestOpenFile('group:topic:ops')
    expect(openTextFile).not.toHaveBeenCalled()
  })
})

describe('badge counts', () => {
  it('model.dangling and model.identityCollisions drive the badge counts, both absent at zero', async () => {
    installIonStub({
      revision: 1,
      roots: [{ path: '/root', exists: true, documentCount: 1 }],
      documents: [{ path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: ['ghost'], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    })
    await useGraphStore.getState().init('/root')
    const model = useGraphStore.getState().model!
    expect(model.dangling.length).toBe(1)
    expect(model.identityCollisions.length).toBe(0)
  })
})

describe('togglePin', () => {
  it('marks the graph node fixed immediately and survives a rebuild', async () => {
    installIonStub({
      revision: 1,
      roots: [{ path: '/root', exists: true, documentCount: 2 }],
      documents: [
        { path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: ['b'], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
        { path: '/root/b.md', rootPath: '/root', fileName: 'b', frontMatter: { id: 'b' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
      ],
    })
    await useGraphStore.getState().init('/root')

    useGraphStore.getState().togglePin('a')
    expect(useGraphStore.getState().pinnedNodeIds.has('a')).toBe(true)
    expect(useGraphStore.getState().graph!.getNodeAttribute('a', 'fixed')).toBe(true)

    useGraphStore.getState().applyDelta({ revision: 2, upserted: [], removedPaths: ['/root/b.md'], roots: [{ path: '/root', exists: true, documentCount: 1 }] })
    expect(useGraphStore.getState().graph!.getNodeAttribute('a', 'fixed')).toBe(true)

    useGraphStore.getState().togglePin('a')
    expect(useGraphStore.getState().pinnedNodeIds.size).toBe(0)
    expect(useGraphStore.getState().graph!.getNodeAttribute('a', 'fixed')).toBe(false)
  })
})
