import { describe, it, expect } from 'vitest'
import { mergeTabStates } from '../tab-backend-merge'
import { SPLIT_SCHEMA_VERSION } from '../tab-migration-split'
import type { PersistedTabState } from '../../shared/types'

// Pure-merge tests for the one-time backend merge (tabs-{api,cli}.json →
// tabs.json). The runner's I/O wrapper is a thin existsSync/atomic-write
// shell around this pure function; the invariants that protect user data
// live here.

function state(partial: Partial<PersistedTabState>): PersistedTabState {
  return {
    schemaVersion: SPLIT_SCHEMA_VERSION,
    activeSessionId: null,
    tabs: [],
    ...partial,
  }
}

function tab(overrides: Record<string, unknown>): PersistedTabState['tabs'][number] {
  return {
    conversationId: null,
    title: 'Untitled',
    customTitle: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    additionalDirs: [],
    ...overrides,
  } as PersistedTabState['tabs'][number]
}

describe('mergeTabStates', () => {
  it('unions tabs from both sides, api first', () => {
    const api = state({ tabs: [tab({ id: 'a1', conversationId: 'conv-a1' })], activeSessionId: 'conv-a1' })
    const cli = state({ tabs: [tab({ id: 'c1', conversationId: 'conv-c1' })], activeSessionId: 'conv-c1' })
    const merged = mergeTabStates(api, cli)
    expect(merged.tabs.map((t) => t.id)).toEqual(['a1', 'c1'])
    expect(merged.activeSessionId).toBe('conv-a1')
    expect(merged.schemaVersion).toBe(SPLIT_SCHEMA_VERSION)
  })

  it('dedupes by durable tab id, keeping the api copy', () => {
    const api = state({ tabs: [tab({ id: 'dup', conversationId: 'conv-api', title: 'api copy' })] })
    const cli = state({ tabs: [tab({ id: 'dup', conversationId: 'conv-cli', title: 'cli copy' })] })
    const merged = mergeTabStates(api, cli)
    expect(merged.tabs).toHaveLength(1)
    expect(merged.tabs[0].conversationId).toBe('conv-api')
  })

  it('dedupes by conversationId when tabs have no durable id', () => {
    const api = state({ tabs: [tab({ conversationId: 'shared-conv' })] })
    const cli = state({ tabs: [tab({ conversationId: 'shared-conv' })] })
    const merged = mergeTabStates(api, cli)
    expect(merged.tabs).toHaveLength(1)
  })

  it('never dedupes anonymous tabs (no id, no conversationId)', () => {
    const api = state({ tabs: [tab({})] })
    const cli = state({ tabs: [tab({})] })
    const merged = mergeTabStates(api, cli)
    expect(merged.tabs).toHaveLength(2)
  })

  it('returns the sole source unchanged when the other is absent', () => {
    const cli = state({ tabs: [tab({ id: 'c1', conversationId: 'conv-c1' })], activeSessionId: 'conv-c1' })
    expect(mergeTabStates(null, cli)).toBe(cli)
    const api = state({ tabs: [tab({ id: 'a1', conversationId: 'conv-a1' })] })
    expect(mergeTabStates(api, null)).toBe(api)
  })

  it('falls back to the cli active tab when api has none, remapping the index', () => {
    const api = state({ tabs: [tab({ id: 'a1' }), tab({ id: 'a2' })], activeSessionId: null, activeTabIndex: null })
    const cli = state({ tabs: [tab({ id: 'c1', conversationId: 'conv-c1' })], activeSessionId: 'conv-c1', activeTabIndex: 0 })
    const merged = mergeTabStates(api, cli)
    expect(merged.activeSessionId).toBe('conv-c1')
    // cli tab index 0 lands after api's 2 tabs.
    expect(merged.activeTabIndex).toBe(2)
  })

  it('unions editor state, api winning per directory', () => {
    const api = state({
      tabs: [],
      editorStates: { '/proj': { activeFileIndex: 1, files: [] } },
      editorOpenDirs: ['/proj'],
    })
    const cli = state({
      tabs: [],
      editorStates: { '/proj': { activeFileIndex: 0, files: [] }, '/other': { activeFileIndex: 0, files: [] } },
      editorOpenDirs: ['/other'],
    })
    const merged = mergeTabStates(api, cli)
    expect(merged.editorStates?.['/proj'].activeFileIndex).toBe(1)
    expect(merged.editorStates?.['/other']).toBeDefined()
    expect(merged.editorOpenDirs).toEqual(['/proj', '/other'])
  })

  it('preserves the total tab count across the union (no silent loss)', () => {
    const api = state({ tabs: Array.from({ length: 20 }, (_, i) => tab({ id: `a${i}`, conversationId: `conv-a${i}` })) })
    const cli = state({ tabs: Array.from({ length: 7 }, (_, i) => tab({ id: `c${i}`, conversationId: `conv-c${i}` })) })
    const merged = mergeTabStates(api, cli)
    expect(merged.tabs).toHaveLength(27)
  })
})
