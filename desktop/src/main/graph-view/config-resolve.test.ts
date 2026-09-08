/**
 * Tests for Graph View configuration resolution (child 01).
 *
 * `config-resolve.ts` is pure and touches no disk, so these tests supply raw
 * settings-file shapes directly.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { resolveGraphViewConfig, normalizeRoots, extractProjectBlock } from './config-resolve'
import { GRAPH_VIEW_DEFAULTS, isGraphViewAvailable } from '../../shared/graph-view-types'

describe('resolveGraphViewConfig', () => {
  it('both files absent, empty projectPath returns defaults with empty corpusRoots', () => {
    const config = resolveGraphViewConfig({}, {}, '')
    expect(config.corpusRoots).toEqual([])
    expect(config.identityField).toBe(GRAPH_VIEW_DEFAULTS.identityField)
    expect(config.labelField).toBe(GRAPH_VIEW_DEFAULTS.labelField)
    expect(config.groupFields).toEqual(GRAPH_VIEW_DEFAULTS.groupFields)
    expect(config.edgeFields).toEqual(GRAPH_VIEW_DEFAULTS.edgeFields)
    expect(config.hoverFields).toEqual(GRAPH_VIEW_DEFAULTS.hoverFields)
    expect(config.sectionNodes).toBe(GRAPH_VIEW_DEFAULTS.sectionNodes)
    expect(config.neighborhoodDepth).toBe(GRAPH_VIEW_DEFAULTS.neighborhoodDepth)
    expect(config.savedViews).toEqual([])
    expect(config.curatedFields).toEqual([])
  })

  it('both files absent, real projectPath defaults corpusRoots to the project directory', () => {
    const config = resolveGraphViewConfig({}, {}, '/Users/josh/cloudops')
    expect(config.corpusRoots).toEqual([{ path: '/Users/josh/cloudops' }])
  })

  it('a project setting its own corpusRoots suppresses the project-cwd default', () => {
    const projectRaw = { desktop: { graphView: { corpusRoots: ['/repo'] } } }
    const config = resolveGraphViewConfig({}, projectRaw, '/Users/josh/cloudops')
    expect(config.corpusRoots).toEqual([{ path: '/repo' }])
  })

  it('a project explicitly setting corpusRoots to [] still suppresses the default', () => {
    const projectRaw = { desktop: { graphView: { corpusRoots: [] } } }
    const config = resolveGraphViewConfig({}, projectRaw, '/Users/josh/cloudops')
    expect(config.corpusRoots).toEqual([])
  })

  it('user-scope roots union in on top of the project-cwd default', () => {
    const userRaw = { desktop: { graphView: { corpusRoots: ['/subscribed-bundle'] } } }
    const config = resolveGraphViewConfig(userRaw, {}, '/Users/josh/cloudops')
    expect(config.corpusRoots.map((r) => r.path)).toEqual(['/Users/josh/cloudops', '/subscribed-bundle'])
  })

  it('project-only sets identityField from project scope', () => {
    const projectRaw = { desktop: { graphView: { identityField: 'uid', corpusRoots: ['/repo'] } } }
    const config = resolveGraphViewConfig({}, projectRaw, '/proj')
    expect(config.identityField).toBe('uid')
    expect(config.corpusRoots).toEqual([{ path: '/repo' }])
  })

  it('user-only sets identityField from user scope', () => {
    const userRaw = { desktop: { graphView: { identityField: 'myid', corpusRoots: ['/repo'] } } }
    const config = resolveGraphViewConfig(userRaw, {}, '/proj')
    expect(config.identityField).toBe('myid')
  })

  it('user scalar outranks project scalar', () => {
    const userRaw = { desktop: { graphView: { identityField: 'from-user' } } }
    const projectRaw = { desktop: { graphView: { identityField: 'from-project' } } }
    const config = resolveGraphViewConfig(userRaw, projectRaw, '/proj')
    expect(config.identityField).toBe('from-user')
  })

  it('corpusRoots is the union of project then user roots, de-duplicated by path, project order first', () => {
    const userRaw = { desktop: { graphView: { corpusRoots: ['/repo-a', '/repo-b'] } } }
    const projectRaw = { desktop: { graphView: { corpusRoots: ['/repo-b', '/repo-c'] } } }
    const config = resolveGraphViewConfig(userRaw, projectRaw, '/proj')
    expect(config.corpusRoots.map((r) => r.path)).toEqual(['/repo-b', '/repo-c', '/repo-a'])
  })

  it('same root in both scopes de-duplicates keeping the project entry (its label)', () => {
    const userRaw = { desktop: { graphView: { corpusRoots: [{ path: '/repo', label: 'user-label' }] } } }
    const projectRaw = { desktop: { graphView: { corpusRoots: [{ path: '/repo', label: 'project-label' }] } } }
    const config = resolveGraphViewConfig(userRaw, projectRaw, '/proj')
    expect(config.corpusRoots).toEqual([{ path: '/repo', label: 'project-label' }])
  })

  it('savedViews concatenates with distinct source, never merging by name', () => {
    const userRaw = {
      desktop: {
        graphView: {
          savedViews: [{ name: 'Default', bindings: {}, filters: [], tagTreatment: 'off', clusterRendering: 'off', positions: {} }],
        },
      },
    }
    const projectRaw = {
      desktop: {
        graphView: {
          savedViews: [{ name: 'Default', bindings: {}, filters: [], tagTreatment: 'off', clusterRendering: 'off', positions: {} }],
        },
      },
    }
    const config = resolveGraphViewConfig(userRaw, projectRaw, '/proj')
    expect(config.savedViews).toHaveLength(2)
    expect(config.savedViews[0].source).toBe('project')
    expect(config.savedViews[1].source).toBe('user')
  })

  it('project file setting desktop.logLevel drops the key and leaves droppedKeys logged', () => {
    const projectRaw = { desktop: { logLevel: 'TRACE', graphView: { identityField: 'uid' } } }
    const { droppedKeys } = extractProjectBlock(projectRaw)
    expect(droppedKeys).toContain('logLevel')
    const config = resolveGraphViewConfig({}, projectRaw, '/proj')
    expect(config.identityField).toBe('uid')
  })

  it('project file setting an unrecognized graphView field drops it', () => {
    const projectRaw = { desktop: { graphView: { someFutureField: 'x', corpusRoots: ['/repo'] } } }
    const { droppedKeys, block } = extractProjectBlock(projectRaw)
    expect(droppedKeys).toContain('someFutureField')
    expect(block.someFutureField).toBeUndefined()
  })

  it('project file top-level key other than desktop is dropped', () => {
    const projectRaw = { desktop: { graphView: { corpusRoots: ['/repo'] } }, someOtherKey: 1 }
    const { droppedKeys } = extractProjectBlock(projectRaw)
    expect(droppedKeys).toContain('someOtherKey')
  })

  it('groupFields/edgeFields/hoverFields/curatedFields take user scope when set, else project, else default', () => {
    const userRaw = { desktop: { graphView: { groupFields: ['topic'] } } }
    const projectRaw = { desktop: { graphView: { groupFields: ['area'], edgeFields: ['links'] } } }
    const config = resolveGraphViewConfig(userRaw, projectRaw, '/proj')
    expect(config.groupFields).toEqual(['topic'])
    expect(config.edgeFields).toEqual(['links'])
    expect(config.hoverFields).toEqual(GRAPH_VIEW_DEFAULTS.hoverFields)
  })

  it('neighborhoodDepth 0 clamps to default', () => {
    const projectRaw = { desktop: { graphView: { neighborhoodDepth: 0 } } }
    const config = resolveGraphViewConfig({}, projectRaw, '/proj')
    expect(config.neighborhoodDepth).toBe(GRAPH_VIEW_DEFAULTS.neighborhoodDepth)
  })

  it('neighborhoodDepth as a string is rejected, falls back to default', () => {
    const projectRaw = { desktop: { graphView: { neighborhoodDepth: '2' } } }
    const config = resolveGraphViewConfig({}, projectRaw, '/proj')
    expect(config.neighborhoodDepth).toBe(GRAPH_VIEW_DEFAULTS.neighborhoodDepth)
  })

  it('neighborhoodDepth 3 (valid) passes through', () => {
    const projectRaw = { desktop: { graphView: { neighborhoodDepth: 3 } } }
    const config = resolveGraphViewConfig({}, projectRaw, '/proj')
    expect(config.neighborhoodDepth).toBe(3)
  })
})

describe('normalizeRoots', () => {
  it('a bare string entry is accepted with no label', () => {
    expect(normalizeRoots(['/repo'], 'user')).toEqual([{ path: '/repo' }])
  })

  it('a non-absolute path after tilde expansion is dropped', () => {
    expect(normalizeRoots(['relative/path'], 'user')).toEqual([])
  })

  it('a malformed entry (number) is dropped', () => {
    expect(normalizeRoots([42], 'user')).toEqual([])
  })

  it('not an array returns empty', () => {
    expect(normalizeRoots(undefined, 'user')).toEqual([])
    expect(normalizeRoots('not-an-array', 'user')).toEqual([])
  })
})

describe('isGraphViewAvailable', () => {
  it('is false with empty corpusRoots (empty projectPath, the invalid-path fallback)', () => {
    const config = resolveGraphViewConfig({}, {}, '')
    expect(isGraphViewAvailable(config)).toBe(false)
  })

  it('is true by default with a real projectPath and no configuration', () => {
    const config = resolveGraphViewConfig({}, {}, '/Users/josh/cloudops')
    expect(isGraphViewAvailable(config)).toBe(true)
  })

  it('is true with at least one configured corpusRoot', () => {
    const config = resolveGraphViewConfig({}, { desktop: { graphView: { corpusRoots: ['/repo'] } } }, '/proj')
    expect(isGraphViewAvailable(config)).toBe(true)
  })
})

describe('defaultView resolution', () => {
  it('defaults to empty, meaning no view is applied on load', () => {
    const config = resolveGraphViewConfig({}, {}, '/proj')
    expect(config.defaultView).toBe('')
  })

  it('is settable from project scope, so a corpus can ship its opening view', () => {
    const config = resolveGraphViewConfig({}, { desktop: { graphView: { defaultView: 'Ops Overview' } } }, '/proj')
    expect(config.defaultView).toBe('Ops Overview')
  })

  it('user scope outranks project scope, like every other scalar', () => {
    const config = resolveGraphViewConfig(
      { desktop: { graphView: { defaultView: 'Mine' } } },
      { desktop: { graphView: { defaultView: 'Theirs' } } },
      '/proj',
    )
    expect(config.defaultView).toBe('Mine')
  })

  it('is on the project allowlist rather than being dropped', () => {
    const { block, droppedKeys } = extractProjectBlock({ desktop: { graphView: { defaultView: 'Ops Overview' } } })
    expect(block.defaultView).toBe('Ops Overview')
    expect(droppedKeys).not.toContain('defaultView')
  })
})

describe('promoted fields and section topics', () => {
  it('reads promotedFields with depth and split, dropping malformed entries, and sectionTopicsField as a scalar', () => {
    const project = {
      desktop: {
        graphView: {
          promotedFields: [
            'path',
            { field: 'orn', depth: 1, split: { separator: ':', index: 3 } },
            { field: 'owner', depth: -1, split: { separator: '', index: 0 } },
            { depth: 2 },
          ],
          sectionTopicsField: 'parts',
        },
      },
    }
    const config = resolveGraphViewConfig({}, project, '/proj')
    expect(config.promotedFields).toEqual([{ field: 'path' }, { field: 'orn', depth: 1, split: { separator: ':', index: 3 } }, { field: 'owner' }])
    expect(config.sectionTopicsField).toBe('parts')
  })

  it('defaults to no promoted fields and the sections field', () => {
    const config = resolveGraphViewConfig({}, {}, '/proj')
    expect(config.promotedFields).toEqual([])
    expect(config.sectionTopicsField).toBe(GRAPH_VIEW_DEFAULTS.sectionTopicsField)
  })

  it('user scope replaces the project promoted list wholesale', () => {
    const user = { desktop: { graphView: { promotedFields: [{ field: 'team' }] } } }
    const project = { desktop: { graphView: { promotedFields: [{ field: 'path' }, { field: 'orn' }] } } }
    expect(resolveGraphViewConfig(user, project, '/proj').promotedFields).toEqual([{ field: 'team' }])
  })
})
