/**
 * Tests for corpus-reindex.ts (child 03): pure delta computation and
 * application. Uses real temp-directory fixtures for existence/stat/read.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeDelta, applyDelta } from './corpus-reindex'
import { GRAPH_VIEW_DEFAULTS } from '../../shared/graph-view-types'
import type { GraphViewConfig } from '../../shared/graph-view-types'
import type { CorpusSnapshot } from '../../shared/graph-corpus-types'

function baseConfig(roots: string[]): GraphViewConfig {
  return {
    corpusRoots: roots.map((path) => ({ path })),
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
  }
}

const EMPTY_SNAPSHOT: CorpusSnapshot = { revision: 0, roots: [], documents: [] }

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-view-reindex-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('computeDelta', () => {
  it('a created file produces one upserted entry', () => {
    const filePath = join(tmpRoot, 'a.md')
    writeFileSync(filePath, '---\nid: a\n---\n')
    const { upserted, removedPaths } = computeDelta(EMPTY_SNAPSHOT, [filePath], baseConfig([tmpRoot]))
    expect(upserted).toHaveLength(1)
    expect(upserted[0].path).toBe(filePath)
    expect(removedPaths).toEqual([])
  })

  it('a deleted known file produces one removedPaths entry', () => {
    const filePath = join(tmpRoot, 'a.md')
    const snapshot: CorpusSnapshot = {
      revision: 1,
      roots: [],
      documents: [{ path: filePath, rootPath: tmpRoot, fileName: 'a', frontMatter: {}, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    }
    const { upserted, removedPaths } = computeDelta(snapshot, [filePath], baseConfig([tmpRoot]))
    expect(upserted).toEqual([])
    expect(removedPaths).toEqual([filePath])
  })

  it('a deleted UNKNOWN file produces no delta entry at all', () => {
    const filePath = join(tmpRoot, 'ghost.md')
    const { upserted, removedPaths } = computeDelta(EMPTY_SNAPSHOT, [filePath], baseConfig([tmpRoot]))
    expect(upserted).toEqual([])
    expect(removedPaths).toEqual([])
  })

  it('a path matching no configured root is skipped', () => {
    const filePath = '/somewhere/else/a.md'
    const { upserted, removedPaths } = computeDelta(EMPTY_SNAPSHOT, [filePath], baseConfig([tmpRoot]))
    expect(upserted).toEqual([])
    expect(removedPaths).toEqual([])
  })

  it('a file over the size cap is treated as removed when known', () => {
    const filePath = join(tmpRoot, 'huge.md')
    writeFileSync(filePath, 'x'.repeat(2 * 1024 * 1024 + 1))
    const snapshot: CorpusSnapshot = {
      revision: 1,
      roots: [],
      documents: [{ path: filePath, rootPath: tmpRoot, fileName: 'huge', frontMatter: {}, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    }
    const { upserted, removedPaths } = computeDelta(snapshot, [filePath], baseConfig([tmpRoot]))
    expect(upserted).toEqual([])
    expect(removedPaths).toEqual([filePath])
  })

  it('picks the longest matching root when roots are nested', () => {
    const inner = join(tmpRoot, 'sub')
    mkdirSync(inner, { recursive: true })
    const filePath = join(inner, 'a.md')
    writeFileSync(filePath, '---\nid: a\n---\n')
    const { upserted } = computeDelta(EMPTY_SNAPSHOT, [filePath], baseConfig([tmpRoot, inner]))
    expect(upserted[0].rootPath).toBe(inner)
  })

  it('a create-then-delete within one window nets to removed only if previously known', () => {
    const filePath = join(tmpRoot, 'transient.md')
    // File does not exist at flush time (simulating create+delete in one window).
    const { upserted, removedPaths } = computeDelta(EMPTY_SNAPSHOT, [filePath], baseConfig([tmpRoot]))
    expect(upserted).toEqual([])
    expect(removedPaths).toEqual([])
  })
})

describe('applyDelta', () => {
  it('upserts and removes by path, preserving watchState', () => {
    const filePath = join(tmpRoot, 'a.md')
    writeFileSync(filePath, '---\nid: a\n---\n')
    const snapshot: CorpusSnapshot = { revision: 1, roots: [], documents: [], watchState: 'watching' }
    const { upserted } = computeDelta(snapshot, [filePath], baseConfig([tmpRoot]))
    const next = applyDelta(snapshot, { revision: 2, upserted, removedPaths: [] }, baseConfig([tmpRoot]))
    expect(next.documents).toHaveLength(1)
    expect(next.revision).toBe(2)
    expect(next.watchState).toBe('watching')
  })

  it('recomputes root documentCount and exists after removal', () => {
    const filePath = join(tmpRoot, 'a.md')
    const snapshot: CorpusSnapshot = {
      revision: 1,
      roots: [{ path: tmpRoot, exists: true, documentCount: 1 }],
      documents: [{ path: filePath, rootPath: tmpRoot, fileName: 'a', frontMatter: {}, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }],
    }
    const next = applyDelta(snapshot, { revision: 2, upserted: [], removedPaths: [filePath] }, baseConfig([tmpRoot]))
    expect(next.roots[0]).toMatchObject({ exists: true, documentCount: 0 })
    expect(next.documents).toEqual([])
  })
})
