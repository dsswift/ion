/**
 * Availability proof for program acceptance criterion 2 (revised): Graph
 * View is enabled by default for any conversation with a real project
 * directory — `resolveGraphViewConfig` defaults `corpusRoots` to
 * `[{ path: projectPath }]` when neither scope configures it, and
 * `isGraphViewAvailable()` is true. The one case that stays unavailable is
 * the invalid-path IPC fallback (`projectPath: ''`), which never gets a
 * default root. The disk-work half of "unavailable does zero disk work" is
 * `corpus-scan.test.ts` TC-013 (child 02).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { resolveGraphViewConfig } from './config-resolve'
import { GRAPH_VIEW_DEFAULTS, isGraphViewAvailable } from '../../shared/graph-view-types'

describe('Graph View availability with no configuration', () => {
  it('resolveGraphViewConfig({}, {}, projectPath) returns GRAPH_VIEW_DEFAULTS values with corpusRoots defaulted to projectPath', () => {
    const config = resolveGraphViewConfig({}, {}, '/Users/josh/cloudops')
    expect(config.corpusRoots).toEqual([{ path: '/Users/josh/cloudops' }])
    expect(config.identityField).toBe(GRAPH_VIEW_DEFAULTS.identityField)
    expect(config.labelField).toBe(GRAPH_VIEW_DEFAULTS.labelField)
    expect(config.groupFields).toEqual(GRAPH_VIEW_DEFAULTS.groupFields)
    expect(config.edgeFields).toEqual(GRAPH_VIEW_DEFAULTS.edgeFields)
    expect(config.hoverFields).toEqual(GRAPH_VIEW_DEFAULTS.hoverFields)
    expect(config.sectionNodes).toBe(GRAPH_VIEW_DEFAULTS.sectionNodes)
    expect(config.neighborhoodDepth).toBe(GRAPH_VIEW_DEFAULTS.neighborhoodDepth)
  })

  it('isGraphViewAvailable is true with no configuration and a real projectPath', () => {
    const config = resolveGraphViewConfig({}, {}, '/Users/josh/cloudops')
    expect(isGraphViewAvailable(config)).toBe(true)
  })

  it('isGraphViewAvailable is false when projectPath is empty (the invalid-path fallback)', () => {
    const config = resolveGraphViewConfig({}, {}, '')
    expect(isGraphViewAvailable(config)).toBe(false)
  })

  it('isGraphViewAvailable is false when both raw inputs and projectPath are empty/undefined', () => {
    const config = resolveGraphViewConfig(undefined, undefined, '')
    expect(isGraphViewAvailable(config)).toBe(false)
  })
})
