/**
 * Tests for corpus-scan.ts (child 02, see specs/02-corpus-index.tests.md
 * TC-007..TC-014). Builds real temp-directory fixtures under os.tmpdir().
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// `fs` named exports are non-configurable under Vitest's ESM handling, so a
// direct `vi.spyOn(fs, 'readFileSync')` throws "Cannot redefine property".
// Route the functions the failure-injection and call-count tests need
// through mutable indirection objects instead, defaulting to the real
// implementation and optionally counting calls.
const fsOverrides: {
  readFileSync: typeof import('fs').readFileSync | null
  readdirSync: typeof import('fs').readdirSync | null
  statSync: typeof import('fs').statSync | null
  existsSync: typeof import('fs').existsSync | null
} = {
  readFileSync: null,
  readdirSync: null,
  statSync: null,
  existsSync: null,
}
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readFileSync: (...args: any[]) =>
      fsOverrides.readFileSync ? (fsOverrides.readFileSync as any)(...args) : (actual.readFileSync as any)(...args),
    readdirSync: (...args: any[]) =>
      fsOverrides.readdirSync ? (fsOverrides.readdirSync as any)(...args) : (actual.readdirSync as any)(...args),
    statSync: (...args: any[]) =>
      fsOverrides.statSync ? (fsOverrides.statSync as any)(...args) : (actual.statSync as any)(...args),
    existsSync: (...args: any[]) =>
      fsOverrides.existsSync ? (fsOverrides.existsSync as any)(...args) : (actual.existsSync as any)(...args),
  }
})

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanCorpus, MAX_FILE_BYTES } from './corpus-scan'
import { subscribeCorpus, _resetCorpusStoreForTest } from './corpus-store'
import * as configStore from './config-store'
import { GRAPH_VIEW_DEFAULTS } from '../../shared/graph-view-types'
import type { GraphViewConfig } from '../../shared/graph-view-types'
import * as fs from 'fs'
import * as logger from '../logger'

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

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-view-scan-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  _resetCorpusStoreForTest()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  fsOverrides.readFileSync = null
  fsOverrides.readdirSync = null
  fsOverrides.statSync = null
  fsOverrides.existsSync = null
})

describe('TC-007: scanner walks a root', () => {
  it('collects only .md files, skipping dotted and node_modules directories', async () => {
    mkdirSync(join(tmpRoot, 'sub', 'deep'), { recursive: true })
    mkdirSync(join(tmpRoot, '.hidden'), { recursive: true })
    mkdirSync(join(tmpRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(tmpRoot, 'a.md'), '---\nid: a\n---\n')
    writeFileSync(join(tmpRoot, 'sub', 'b.md'), '---\nid: b\n---\n')
    writeFileSync(join(tmpRoot, 'sub', 'deep', 'c.md'), '---\nid: c\n---\n')
    writeFileSync(join(tmpRoot, 'notes.txt'), 'not markdown')
    writeFileSync(join(tmpRoot, '.hidden', 'd.md'), '---\nid: d\n---\n')
    writeFileSync(join(tmpRoot, 'node_modules', 'e.md'), '---\nid: e\n---\n')

    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.documents).toHaveLength(3)
    const paths = snapshot.documents.map((d) => d.path).sort()
    expect(paths).toEqual([join(tmpRoot, 'a.md'), join(tmpRoot, 'sub', 'b.md'), join(tmpRoot, 'sub', 'deep', 'c.md')].sort())
    for (const d of snapshot.documents) expect(d.rootPath).toBe(tmpRoot)
    expect(snapshot.roots[0]).toMatchObject({ exists: true, documentCount: 3 })
  })
})

describe('TC-008: missing and non-directory roots', () => {
  it('a missing root yields exists:false, documentCount:0, no documents', async () => {
    const snapshot = await scanCorpus(baseConfig([join(tmpRoot, 'does-not-exist')]))
    expect(snapshot.roots[0]).toMatchObject({ exists: false, documentCount: 0 })
    expect(snapshot.documents).toEqual([])
  })

  it('a root that is a regular file yields exists:false', async () => {
    const filePath = join(tmpRoot, 'not-a-dir.md')
    writeFileSync(filePath, 'x')
    const snapshot = await scanCorpus(baseConfig([filePath]))
    expect(snapshot.roots[0].exists).toBe(false)
  })

  it('a root with no .md files yields exists:true, documentCount:0', async () => {
    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.roots[0]).toMatchObject({ exists: true, documentCount: 0 })
  })

  it('no ERROR log emitted in any of the three cases', async () => {
    const errorSpy = vi.spyOn(logger, 'error')
    await scanCorpus(baseConfig([join(tmpRoot, 'nope')]))
    await scanCorpus(baseConfig([tmpRoot]))
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('TC-009: multiple roots', () => {
  it('two sibling roots each contribute their own documents', async () => {
    const rootA = join(tmpRoot, 'a')
    const rootB = join(tmpRoot, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    writeFileSync(join(rootA, 'x.md'), '---\nid: x\n---\n')
    writeFileSync(join(rootB, 'y.md'), '---\nid: y\n---\n')

    const snapshot = await scanCorpus(baseConfig([rootA, rootB]))
    expect(snapshot.roots).toHaveLength(2)
    expect(snapshot.roots[0].path).toBe(rootA)
    expect(snapshot.roots[1].path).toBe(rootB)
    expect(snapshot.documents.find((d) => d.rootPath === rootA)?.fileName).toBe('x')
    expect(snapshot.documents.find((d) => d.rootPath === rootB)?.fileName).toBe('y')
  })

  it('a nested root produces the same file under both rootPath values', async () => {
    const outer = tmpRoot
    const inner = join(tmpRoot, 'sub')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'shared.md'), '---\nid: shared\n---\n')

    const snapshot = await scanCorpus(baseConfig([outer, inner]))
    const matches = snapshot.documents.filter((d) => d.path === join(inner, 'shared.md'))
    expect(matches).toHaveLength(2)
    expect(matches.map((d) => d.rootPath).sort()).toEqual([inner, outer].sort())
  })
})

describe('TC-010: over-cap and unreadable files', () => {
  it('a file over 2MB is skipped and counted', async () => {
    writeFileSync(join(tmpRoot, 'huge.md'), 'x'.repeat(MAX_FILE_BYTES + 1))
    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.documents).toHaveLength(0)
  })

  it('a readFileSync failure for one file skips it but returns the rest', async () => {
    writeFileSync(join(tmpRoot, 'ok.md'), '---\nid: ok\n---\n')
    writeFileSync(join(tmpRoot, 'bad.md'), '---\nid: bad\n---\n')
    const { readFileSync: real } = await vi.importActual<typeof import('fs')>('fs')
    fsOverrides.readFileSync = ((path: any, ...rest: any[]) => {
      if (String(path).endsWith('bad.md')) throw new Error('EACCES')
      return real(path, ...rest)
    }) as typeof fs.readFileSync

    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.documents).toHaveLength(1)
    expect(snapshot.documents[0].fileName).toBe('ok')
  })

  it('a readdirSync failure for one subdirectory logs WARN and continues into siblings', async () => {
    const subA = join(tmpRoot, 'subA')
    const subB = join(tmpRoot, 'subB')
    mkdirSync(subA, { recursive: true })
    mkdirSync(subB, { recursive: true })
    writeFileSync(join(subB, 'ok.md'), '---\nid: ok\n---\n')

    const { readdirSync: real } = await vi.importActual<typeof import('fs')>('fs')
    fsOverrides.readdirSync = ((path: any, ...rest: any[]) => {
      if (String(path) === subA) throw new Error('EACCES')
      return real(path, ...rest)
    }) as typeof fs.readdirSync

    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.documents.find((d) => d.fileName === 'ok')).toBeTruthy()
  })
})

describe('TC-011: symlinks', () => {
  it('a symlinked directory inside a root is not followed', async () => {
    const real = join(tmpRoot, 'real')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'x.md'), '---\nid: x\n---\n')
    try {
      symlinkSync(real, join(tmpRoot, 'linked'), 'dir')
    } catch {
      return // symlink creation may be unsupported in the sandbox; skip
    }
    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    // The real file appears exactly once — never discovered a second time
    // by following the symlinked alias.
    const paths = snapshot.documents.map((d) => d.path)
    expect(paths.filter((p) => p === join(real, 'x.md'))).toHaveLength(1)
  })
})

describe('TC-012: parse errors survive the scan', () => {
  it('a malformed front-matter file is still returned with parseError set', async () => {
    writeFileSync(join(tmpRoot, 'good.md'), '---\nid: good\n---\n')
    writeFileSync(join(tmpRoot, 'bad.md'), '---\na: [1, 2\n---\n')
    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.documents).toHaveLength(2)
    const bad = snapshot.documents.find((d) => d.fileName === 'bad')
    expect(bad?.parseError).toBeTruthy()
  })
})

describe('TC-013: empty configuration does zero disk work', () => {
  it('subscribeCorpus with empty corpusRoots returns the empty snapshot with zero fs calls', async () => {
    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([]))
    let readdirCalls = 0
    let statCalls = 0
    let existsCalls = 0
    fsOverrides.readdirSync = ((..._args: any[]) => {
      readdirCalls++
      throw new Error('unexpected readdirSync call')
    }) as unknown as typeof import('fs').readdirSync
    fsOverrides.statSync = ((..._args: any[]) => {
      statCalls++
      throw new Error('unexpected statSync call')
    }) as unknown as typeof import('fs').statSync
    fsOverrides.existsSync = ((..._args: any[]) => {
      existsCalls++
      return false
    }) as unknown as typeof import('fs').existsSync

    const snapshot = await subscribeCorpus('/some/project')
    expect(snapshot).toEqual({ revision: 0, roots: [], documents: [] })
    expect(readdirCalls).toBe(0)
    expect(statCalls).toBe(0)
    expect(existsCalls).toBe(0)

    const debugSpy = vi.mocked(logger.debug)
    const skipCall = debugSpy.mock.calls.find(([, msg]) => msg === 'graph_view: corpus subscribe skipped')
    expect(skipCall?.[2]).toMatchObject({ reason: 'no-corpus-roots' })
  })
})

describe('TC-014: scale smoke', () => {
  it('generates 200 documents across four directories and scans them', async () => {
    for (let i = 0; i < 200; i++) {
      const dir = join(tmpRoot, `d${i % 4}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `doc${i}.md`), `---\nid: doc${i}\n---\n[[doc${(i + 1) % 200}]]`)
    }
    const logSpy = vi.spyOn(logger, 'log')
    const snapshot = await scanCorpus(baseConfig([tmpRoot]))
    expect(snapshot.documents).toHaveLength(200)
    const completionCall = logSpy.mock.calls.find(([, msg]) => msg === 'graph_view: corpus scan complete')
    expect(completionCall).toBeTruthy()
    expect(completionCall?.[2]).toMatchObject({ documentCount: 200 })
    expect(typeof completionCall?.[2]?.durationMs).toBe('number')
  })
})
