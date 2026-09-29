/**
 * host-api-misc persistence — regression tests for the tab/session/
 * conversation persistence functions that used to be no-op stubs
 * (`saveTabs`, `deleteTabContent`, `deleteStoredConversations`,
 * `generateTitle`, `saveSessionLabel`, `loadSessionChains`,
 * `saveSessionChains`) once the Overlay renderer that used to persist this
 * state through Electron IPC (`desktop/main/ipc/settings.ts`) was removed,
 * making the server the sole remaining writer.
 *
 * `saveTabs`/`loadTabs` round-trip against a REAL temp file (the migration
 * runners and the guard/backup logic are exercised for real; only the
 * migration outcomes themselves are unit-tested elsewhere in
 * `persistence/__tests__/`, so those runners are mocked here to no-ops to
 * keep this file about the wiring, not the migrations). Everything else is
 * pinned by asserting delegation to the real underlying implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PersistedTabState } from '@ion/shared/types-persistence'

vi.mock('../../logger', () => ({
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

let tmpDir: string
let tabsFile: string

vi.mock('../../persistence/settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../persistence/settings-store')>()
  return {
    ...actual,
    tabsFile: () => tabsFile,
    settingsDir: () => tmpDir,
    loadSessionLabels: vi.fn(() => ({})),
    saveSessionLabels: vi.fn(),
    loadSessionChains: vi.fn(() => ({ chains: {}, reverse: {} })),
    saveSessionChains: vi.fn(),
  }
})

vi.mock('../../persistence/tab-backend-merge', () => ({
  runTabBackendMerge: vi.fn(() => ({ migrated: false, reason: 'no-file' })),
}))
vi.mock('../../persistence/tab-migration-unify-runner', () => ({
  runTabUnifyMigration: vi.fn(() => ({ migrated: false, reason: 'no-file' })),
}))
vi.mock('../../persistence/tab-migration-split-runner', () => ({
  runTabSplitMigration: vi.fn(() => ({ migrated: false, reason: 'no-file' })),
}))
vi.mock('../../persistence/tab-migration-externalize-runner', () => ({
  runTabExternalizeMigration: vi.fn(() => ({ migrated: false, reason: 'no-file' })),
}))
// Content files are REAL (under the temp settings dir) so the save/load
// guards can read the one signal they key on -- whether a dropped tab's
// content is still on disk -- while the delegation tests below still get
// spies over the same functions.
vi.mock('../../persistence/tab-content-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../persistence/tab-content-store')>()
  return {
    ...actual,
    loadInstanceContent: vi.fn(() => null),
    saveInstanceContent: vi.fn(actual.saveInstanceContent),
    deleteInstanceContent: vi.fn(actual.deleteInstanceContent),
    mergeExternalContent: vi.fn((thin) => thin),
  }
})

const { deleteStoredConversations, generateTitle } = vi.hoisted(() => ({
  deleteStoredConversations: vi.fn(async () => ({ deleted: 1 })),
  generateTitle: vi.fn(async () => 'A Generated Title'),
}))
vi.mock('../../state', () => ({
  state: {},
  terminalScrollback: new Map(),
  bashProcesses: new Map(),
  sessionPlane: {},
  engineBridge: { deleteStoredConversations, generateTitle },
}))

const { loadSessionReal } = vi.hoisted(() => ({
  loadSessionReal: vi.fn(async () => [{ role: 'user', content: 'real history' }]),
}))
vi.mock('../session-reads', () => ({ loadSession: loadSessionReal }))

import * as hostApiMisc from '../host-api-misc'
import { saveInstanceContent, deleteInstanceContent } from '../../persistence/tab-content-store'
import { loadSessionLabels, saveSessionLabels, loadSessionChains as loadChainsFromDisk, saveSessionChains as saveChainsToDisk } from '../../persistence/settings-store'

function tab(id: string): PersistedTabState['tabs'][number] {
  return { id, conversationId: null, workingDirectory: '/tmp' } as PersistedTabState['tabs'][number]
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'host-api-misc-'))
  tabsFile = join(tmpDir, 'tabs.json')
  vi.clearAllMocks()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('saveTabs / loadTabs', () => {
  it('saveTabs actually writes the tabs file (regression: used to be a no-op that discarded every save)', async () => {
    const data = { schemaVersion: 4, tabs: [tab('t1')], activeTabIndex: 0 } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(data)
    expect(existsSync(tabsFile)).toBe(true)
    const onDisk = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(onDisk.tabs).toHaveLength(1)
    expect(onDisk.tabs[0].id).toBe('t1')
  })

  it('loadTabs reads back exactly what saveTabs wrote (round trip)', async () => {
    const data = { schemaVersion: 4, tabs: [tab('t1'), tab('t2')], activeTabIndex: 1 } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(data)
    const loaded = await hostApiMisc.loadTabs()
    expect(loaded?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('loadTabs returns null when no tabs file exists yet', async () => {
    const loaded = await hostApiMisc.loadTabs()
    expect(loaded).toBeNull()
  })

  /** A tab with messages on disk: what a truncated save would silently lose. */
  function withContent(id: string): PersistedTabState['tabs'][number] {
    saveInstanceContent(id, 'inst-1', [{ id: `m-${id}`, role: 'user', content: 'hello' }] as never)
    return tab(id)
  }

  it('guards against a save that would orphan tabs whose messages are still on disk', async () => {
    const many = { schemaVersion: 4, tabs: Array.from({ length: 4 }, (_, i) => withContent(`t${i}`)), activeTabIndex: 0 } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(many)
    // A buggy save that forgot three tabs -- none of them was closed, so
    // their content files are all still there.
    const few = { schemaVersion: 4, tabs: [tab('t0')], activeTabIndex: 0 } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(few)
    const onDisk = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(onDisk.tabs).toHaveLength(4)
    expect(existsSync(tabsFile + '.rejected')).toBe(true)
  })

  it('accepts a save that drops a tab whose content was deleted first (a deliberate close), however small the manifest gets', async () => {
    // Regression: the guard used to compare COUNTS, so closing one of two
    // tabs on a small install was indistinguishable from truncation.
    const two = { schemaVersion: 4, tabs: [withContent('keep'), withContent('closed')], activeTabIndex: 0 } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(two)
    deleteInstanceContent('closed')
    const one = { schemaVersion: 4, tabs: [tab('keep')], activeTabIndex: 0 } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(one)
    const onDisk = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(onDisk.tabs.map((t: { id: string }) => t.id)).toEqual(['keep'])
    expect(existsSync(tabsFile + '.rejected')).toBe(false)
  })

  it('accepts a settle: the tab leaves `tabs` for `settledHistory` with its content file intact', async () => {
    // The refused-save loop as it happened: settling one conversation moved
    // it to settledHistory, its content stayed on disk for review, and the
    // guard -- reading only `tabs` -- refused that save and every save after
    // it. The settle came back on the next boot; the tab created after it was
    // never written at all.
    const open = { schemaVersion: 4, tabs: [withContent('keep'), withContent('done')], activeTabIndex: 0, settledHistory: [] } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(open)
    const settled = { schemaVersion: 4, tabs: [tab('keep')], activeTabIndex: 0, settledHistory: [tab('done')] } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(settled)
    let onDisk = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(onDisk.tabs.map((t: { id: string }) => t.id)).toEqual(['keep'])
    expect(onDisk.settledHistory.map((t: { id: string }) => t.id)).toEqual(['done'])
    expect(existsSync(tabsFile + '.rejected')).toBe(false)
    // And the next save -- a new tab -- is accepted too, with the settled
    // record still on disk.
    const next = { schemaVersion: 4, tabs: [tab('keep'), tab('new')], activeTabIndex: 1, settledHistory: [tab('done')] } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(next)
    onDisk = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(onDisk.tabs.map((t: { id: string }) => t.id)).toEqual(['keep', 'new'])
    // Dropping the settled record while its content is still on disk IS the
    // orphaning save the guard exists for.
    const dropped = { schemaVersion: 4, tabs: [tab('keep'), tab('new')], activeTabIndex: 1, settledHistory: [] } as unknown as PersistedTabState
    await hostApiMisc.saveTabs(dropped)
    onDisk = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(onDisk.settledHistory.map((t: { id: string }) => t.id)).toEqual(['done'])
    expect(existsSync(tabsFile + '.rejected')).toBe(true)
  })

  it('recovers from the .prev rolling backup when the primary looks truncated', async () => {
    // Simulate a crash mid-write: .prev holds the last-known-good 15 tabs,
    // the primary was truncated to 1 tab before the crash landed -- and the
    // other 14 tabs' content files are still on disk, unclaimed.
    const good = { schemaVersion: 4, tabs: Array.from({ length: 15 }, (_, i) => withContent(`t${i}`)), activeTabIndex: 0 }
    const truncated = { schemaVersion: 4, tabs: [tab('t0')], activeTabIndex: 0 }
    const { writeFileSync } = await import('fs')
    writeFileSync(tabsFile + '.prev', JSON.stringify(good))
    writeFileSync(tabsFile, JSON.stringify(truncated))
    const loaded = await hostApiMisc.loadTabs()
    expect(loaded?.tabs).toHaveLength(15)
  })

  it('does not resurrect a deliberately deleted tab from .prev on the next boot', async () => {
    // Regression (first Grover deploy): delete one of two tabs, restart the
    // server, and the deleted tab came back -- .prev "had more tabs" and the
    // primary "had fewer than ten". The deleted tab's content file is gone,
    // which is exactly what says the deletion was meant.
    const before = { schemaVersion: 4, tabs: [withContent('keep'), withContent('deleted')], activeTabIndex: 0 }
    const after = { schemaVersion: 4, tabs: [tab('keep')], activeTabIndex: 0 }
    deleteInstanceContent('deleted')
    const { writeFileSync } = await import('fs')
    writeFileSync(tabsFile + '.prev', JSON.stringify(before))
    writeFileSync(tabsFile, JSON.stringify(after))
    const loaded = await hostApiMisc.loadTabs()
    expect(loaded?.tabs.map((t) => t.id)).toEqual(['keep'])
  })

  it('trusts a primary that dropped only tabs that never had messages', async () => {
    const before = { schemaVersion: 4, tabs: [tab('empty-a'), tab('empty-b'), withContent('real')], activeTabIndex: 0 }
    const after = { schemaVersion: 4, tabs: [tab('real')], activeTabIndex: 0 }
    const { writeFileSync } = await import('fs')
    writeFileSync(tabsFile + '.prev', JSON.stringify(before))
    writeFileSync(tabsFile, JSON.stringify(after))
    const loaded = await hostApiMisc.loadTabs()
    expect(loaded?.tabs.map((t) => t.id)).toEqual(['real'])
  })
})

describe('tab content delegation', () => {
  it('saveTabContent delegates to saveInstanceContent (regression: used to be a no-op)', async () => {
    await hostApiMisc.saveTabContent('tab-1', 'main', [{ role: 'user' }] as never)
    expect(saveInstanceContent).toHaveBeenCalledWith('tab-1', 'main', [{ role: 'user' }])
  })

  it('deleteTabContent delegates to deleteInstanceContent (regression: used to be a no-op)', async () => {
    await hostApiMisc.deleteTabContent('tab-1')
    expect(deleteInstanceContent).toHaveBeenCalledWith('tab-1')
  })
})

describe('deleteStoredConversations / generateTitle / loadSession', () => {
  it('deleteStoredConversations delegates to the engine bridge (regression: used to silently do nothing)', async () => {
    await hostApiMisc.deleteStoredConversations(['s1', 's2'])
    expect(deleteStoredConversations).toHaveBeenCalledWith(['s1', 's2'])
  })

  it('generateTitle delegates to the engine bridge (regression: used to always resolve empty string)', async () => {
    const title = await hostApiMisc.generateTitle('some conversation text')
    expect(generateTitle).toHaveBeenCalledWith('some conversation text')
    expect(title).toBe('A Generated Title')
  })

  it('loadSession delegates to the real session-reads implementation (regression: used to always resolve empty, silently dropping pre-fork/rewind history on every restore)', async () => {
    const history = await hostApiMisc.loadSession('conv-1', '/repo', 'encoded-dir')
    expect(loadSessionReal).toHaveBeenCalledWith({ sessionId: 'conv-1', projectPath: '/repo', encodedDir: 'encoded-dir' })
    expect(history).toEqual([{ role: 'user', content: 'real history' }])
  })
})

describe('session labels / chains delegation', () => {
  it('saveSessionLabel merges into the on-disk label map (regression: used to be a no-op)', async () => {
    vi.mocked(loadSessionLabels).mockReturnValue({ existing: 'Existing' })
    await hostApiMisc.saveSessionLabel('conv-1', 'My Title')
    expect(saveSessionLabels).toHaveBeenCalledWith({ existing: 'Existing', 'conv-1': 'My Title' })
  })

  it('saveSessionLabel with a null label deletes the entry', async () => {
    vi.mocked(loadSessionLabels).mockReturnValue({ 'conv-1': 'My Title' })
    await hostApiMisc.saveSessionLabel('conv-1', null)
    expect(saveSessionLabels).toHaveBeenCalledWith({})
  })

  it('loadSessionChains / saveSessionChains delegate to the real settings-store implementation (regression: used to be no-ops returning empty state)', async () => {
    vi.mocked(loadChainsFromDisk).mockReturnValue({ chains: { a: ['b'] }, reverse: { b: 'a' } })
    const loaded = await hostApiMisc.loadSessionChains()
    expect(loaded).toEqual({ chains: { a: ['b'] }, reverse: { b: 'a' } })

    await hostApiMisc.saveSessionChains({ chains: { x: ['y'] }, reverse: { y: 'x' } })
    expect(saveChainsToDisk).toHaveBeenCalledWith({ chains: { x: ['y'] }, reverse: { y: 'x' } })
  })
})
