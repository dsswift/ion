import { describe, expect, it } from 'vitest'
import { emptySurfacePersisted, parseSurfacePersisted, serializeSurface, validateSurfacePersisted } from '../studio-surface-persistence'
import type { SurfaceConversationPersisted, SurfaceTab } from '../studio-surface-types'

const tabs: SurfaceTab[] = [
  { kind: 'singleton', id: 'diff' },
  { kind: 'file', id: 'file:/repo/a.ts', filePath: '/repo/a.ts', dir: '/repo' },
  { kind: 'browser', id: 'browser:b1', instanceId: 'b1', url: 'https://example.org', title: 'Example', mode: 'browse', sessionMode: 'isolated' },
]
const conversation: SurfaceConversationPersisted = { tabs, activeTabId: 'file:/repo/a.ts', visible: true, agentBrowserInstanceId: 'b1' }

describe('surface persistence', () => {
  it('defaults Plan as the only global pin', () => {
    expect(emptySurfacePersisted()).toEqual({ version: 4, pinnedTabs: ['plan'], notification: null, conversations: {}, scratchProjects: {} })
  })

  it('defaults a legacy browse tab without sessionMode to shared', () => {
    const parsed = parseSurfacePersisted({
      version: 1,
      tabs: [{ kind: 'browser', instanceId: 'legacy', url: 'https://example.org', title: 'Legacy', mode: 'browse' }],
      activeTabId: 'browser:legacy',
    })

    expect(parsed).toMatchObject({
      tabs: [{ kind: 'browser', instanceId: 'legacy', sessionMode: 'shared' }],
    })
  })

  it('preserves an explicit isolated browser session', () => {
    const parsed = parseSurfacePersisted({
      version: 1,
      tabs: [{ kind: 'browser', instanceId: 'private', url: 'https://example.org', title: 'Private', mode: 'browse', sessionMode: 'isolated' }],
      activeTabId: 'browser:private',
    })

    expect(parsed).toMatchObject({
      tabs: [{ kind: 'browser', instanceId: 'private', sessionMode: 'isolated' }],
    })
  })

  it('round-trips conversation records and global pins', () => {
    const persisted = serializeSurface(['diff', 'plan'], null, { alpha: conversation })
    const parsed = parseSurfacePersisted(JSON.parse(JSON.stringify(persisted)))
    expect(parsed).toEqual(persisted)
    expect(validateSurfacePersisted(persisted)).toBe(true)
  })

  it('requires the version 4 Scratch Document map on new writes', () => {
    expect(validateSurfacePersisted({ version: 4, pinnedTabs: ['plan'], notification: null, conversations: {} })).toBe(false)
    expect(validateSurfacePersisted(emptySurfacePersisted())).toBe(true)
  })

  it('round-trips project-scoped Scratch Documents and strips runtime errors', () => {
    const persisted = serializeSurface(['plan'], null, {
      alpha: { tabs: [], activeTabId: 'scratch:s1', visible: true, agentBrowserInstanceId: null },
    }, {
      '/repo': { documents: [{ id: 's1', fileName: 'Untitled-1.md', content: 'notes', savedContent: '', isPreview: false, wordWrap: true, saveError: 'old failure' }] },
    })

    expect(persisted.scratchProjects['/repo']?.documents[0]).toEqual({
      id: 's1', fileName: 'Untitled-1.md', content: 'notes', savedContent: '', isPreview: false, wordWrap: true,
    })
    expect(persisted.conversations.alpha?.tabs).toEqual([])
    expect(persisted.conversations.alpha?.activeTabId).toBe('scratch:s1')
    expect(parseSurfacePersisted(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted)
  })

  it('migrates v3 with no Scratch Documents', () => {
    const parsed = parseSurfacePersisted({
      version: 3,
      pinnedTabs: ['plan'],
      notification: null,
      conversations: { alpha: conversation },
    })

    expect(parsed).toMatchObject({ version: 4, scratchProjects: {} })
  })

  it('drops malformed Scratch Documents without dropping valid project content', () => {
    const parsed = parseSurfacePersisted({
      version: 4,
      pinnedTabs: ['plan'],
      notification: null,
      conversations: {},
      scratchProjects: {
        '/repo': { documents: [
          { id: 'good', fileName: 'Untitled-1.md', content: 'notes', savedContent: '', isPreview: false },
          { id: '', fileName: 'bad.md', content: 'bad', savedContent: '', isPreview: false },
        ] },
      },
    })

    expect(parsed).toMatchObject({
      scratchProjects: { '/repo': { documents: [{ id: 'good', content: 'notes' }] } },
    })
  })

  it('normalizes pinned priority before selecting a conversation fallback', () => {
    const parsed = parseSurfacePersisted({
      version: 2,
      pinnedTabs: ['diff', 'plan'],
      notification: null,
      conversations: { alpha: { tabs: [], activeTabId: null, visible: false } },
    })

    expect(parsed).toMatchObject({
      pinnedTabs: ['plan', 'diff'],
      conversations: { alpha: { activeTabId: 'plan' } },
    })
  })

  it('drops a row whose only state is a pinned-tab selection', () => {
    // This test previously asserted the row was KEPT, which is what let the
    // file grow without bound: every conversation the operator ever opened
    // while Diff or Plan was focused earned a permanent record, and nothing
    // pruned it. Real usage reached 579 records, 539 of them empty.
    //
    // The trade is deliberate. Plan and Diff are global tabs showing the same
    // content in every conversation, so the only thing forgotten is which of
    // the two was last focused there; it falls back to the first pin. Every
    // piece of genuine per-conversation state — browser tabs, terminals,
    // files, the open panel — is kept by the cases below.
    const persisted = serializeSurface(['plan'], null, {
      alpha: { tabs: [], activeTabId: 'plan', visible: false, agentBrowserInstanceId: null },
    })

    expect(persisted.conversations.alpha).toBeUndefined()
    expect(persisted.pinnedTabs).toEqual(['plan'])
    expect(parseSurfacePersisted(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted)
  })

  it('drops malformed conversation records and invalid pins', () => {
    const parsed = parseSurfacePersisted({ version: 2, pinnedTabs: ['plan', 'files', 'plan'], conversations: { valid: conversation, broken: { tabs: [] } } })
    expect(parsed).toMatchObject({ version: 4, pinnedTabs: ['plan'] })
    expect((parsed as { conversations: Record<string, unknown> }).conversations).toHaveProperty('valid')
    expect((parsed as { conversations: Record<string, unknown> }).conversations).not.toHaveProperty('broken')
  })

  it('reads v1 only for migration and rejects it as a new write', () => {
    const legacy = parseSurfacePersisted({ version: 1, tabs, activeTabId: 'diff' })
    expect(legacy).toMatchObject({ version: 1, activeTabId: 'diff' })
    expect(validateSurfacePersisted({ version: 1, tabs, activeTabId: 'diff' })).toBe(false)
  })

  it('defaults legacy browser records to a shared session', () => {
    const parsed = parseSurfacePersisted({
      version: 2,
      pinnedTabs: ['plan'],
      notification: null,
      conversations: {
        alpha: {
          tabs: [{ kind: 'browser', instanceId: 'legacy', url: 'https://example.org', mode: 'browse' }],
          activeTabId: 'browser:legacy',
          visible: true,
        },
      },
    })

    expect(parsed).toMatchObject({
      conversations: { alpha: { tabs: [{ sessionMode: 'shared' }] } },
    })
  })

  it('round-trips a conversation dispatch preview', () => {
    const dispatch = { kind: 'dispatch' as const, id: 'dispatch-preview' as const, agentName: 'dev-lead', dispatchId: 'dispatch-1', title: 'Dev Lead' }
    const persisted = serializeSurface(['plan'], null, {
      alpha: { tabs: [dispatch], activeTabId: dispatch.id, visible: true, agentBrowserInstanceId: null },
    })

    expect(parseSurfacePersisted(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted)
  })

  it('preserves the global notification and excludes it from local records', () => {
    const notification = { kind: 'notification' as const, id: 'notification' as const, resourceKind: 'x', resourceId: 'y' }
    const persisted = serializeSurface(['plan'], notification, { alpha: { tabs: [...tabs, notification, { kind: 'runtime-panel', id: 'runtime:x', title: 'X' }], activeTabId: 'notification', visible: false, agentBrowserInstanceId: 'b1' } })
    expect(persisted.notification).toEqual(notification)
    expect(persisted.conversations.alpha?.tabs.map((tab) => tab.kind)).not.toContain('notification')
    expect(persisted.conversations.alpha?.tabs.map((tab) => tab.kind)).not.toContain('runtime-panel')
  })
})

describe('empty-record pruning', () => {
  const pins = ['plan', 'diff'] as const

  function row(over: Partial<{ tabs: unknown[]; activeTabId: string | null; visible: boolean; agentBrowserInstanceId: string | null }> = {}) {
    return { tabs: [], activeTabId: null, visible: false, agentBrowserInstanceId: null, ...over } as never
  }

  it('drops a record that only points at a global pin', () => {
    // Clicking the shared Diff or Plan tab writes activeTabId for whatever
    // conversation you are in. The pins are already stored once at the top
    // level, so the row says nothing — and nothing ever pruned it. Real usage
    // reached 539 such rows against 40 real ones, 82KB rewritten on every
    // surface change.
    const out = serializeSurface(pins, null, { alpha: row({ activeTabId: 'diff' }), beta: row({ activeTabId: 'plan' }) })
    expect(Object.keys(out.conversations)).toEqual([])
    // The pins themselves are untouched.
    expect(out.pinnedTabs).toEqual(['plan', 'diff'])
  })

  it('keeps a record with its own tabs', () => {
    const out = serializeSurface(pins, null, {
      alpha: row({ tabs: [{ kind: 'browser', id: 'browser:b1', instanceId: 'b1', url: 'https://x.test/', title: 'x', mode: 'browse', sessionMode: 'shared' }] }),
    })
    expect(Object.keys(out.conversations)).toEqual(['alpha'])
  })

  it('keeps a record whose panel was left open', () => {
    // This is the state that decides whether the surface reopens; dropping it
    // would reintroduce the "panel always closed on restart" bug.
    const out = serializeSurface(pins, null, { alpha: row({ visible: true, activeTabId: 'diff' }) })
    expect(Object.keys(out.conversations)).toEqual(['alpha'])
    expect(out.conversations.alpha?.visible).toBe(true)
  })

  it('keeps a record pointing at a tab of its own', () => {
    const out = serializeSurface(pins, null, {
      alpha: row({
        tabs: [{ kind: 'terminal', id: 'terminal:t1', instanceId: 't1', title: 't' }],
        activeTabId: 'terminal:t1',
      }),
    })
    expect(Object.keys(out.conversations)).toEqual(['alpha'])
  })

  it('keeps the notification pointer distinct from a pin', () => {
    const notification = { kind: 'notification', id: 'notification', resourceId: 'r1', title: 'n' } as never
    // Pointing at the global notification tab is no more per-conversation
    // state than pointing at a pin.
    const out = serializeSurface(pins, notification, { alpha: row({ activeTabId: 'notification' }) })
    expect(Object.keys(out.conversations)).toEqual([])
  })
})
