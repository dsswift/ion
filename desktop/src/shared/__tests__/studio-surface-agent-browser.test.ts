import { describe, expect, it } from 'vitest'
import {
  emptySurfacePersisted,
  parseSurfacePersisted,
  serializeSurface,
  validateSurfacePersisted,
} from '../studio-surface-persistence'
import { normalizeTabs } from '../studio-surface-ordering'
import type { SurfaceTab } from '../studio-surface-types'

const browser = (instanceId: string, mode: 'browse' | 'preview' = 'browse'): SurfaceTab => ({
  kind: 'browser',
  id: `browser:${instanceId}`,
  instanceId,
  url: `https://example.org/${instanceId}`,
  title: instanceId,
  mode,
  sessionMode: 'shared',
})

const v2 = (tabs: SurfaceTab[]): unknown => ({
  version: 2,
  pinnedTabs: ['plan'],
  notification: null,
  conversations: { alpha: { tabs, activeTabId: null, visible: false } },
})

describe('agent-linked browser pointer', () => {
  it('back-fills the first browser tab when migrating a v2 record', () => {
    const parsed = parseSurfacePersisted(v2([browser('b1'), browser('b2')]))
    expect(parsed).toMatchObject({ version: 4 })
    expect((parsed as { conversations: Record<string, { agentBrowserInstanceId: string | null }> }).conversations.alpha?.agentBrowserInstanceId).toBe('b1')
  })

  it('back-fills a preview tab when it is the conversation first browser', () => {
    // A preview is still a browser guest the agent can inspect, so a v2
    // record whose only browser is a preview links it rather than staying
    // null and silently having no agent target at all.
    const parsed = parseSurfacePersisted(v2([browser('p1', 'preview')]))
    expect((parsed as { conversations: Record<string, { agentBrowserInstanceId: string | null }> }).conversations.alpha?.agentBrowserInstanceId).toBe('p1')
  })

  it('leaves the pointer null when a migrated conversation has no browser', () => {
    const parsed = parseSurfacePersisted(v2([{ kind: 'singleton', id: 'diff' }]))
    expect((parsed as { conversations: Record<string, { agentBrowserInstanceId: string | null }> }).conversations.alpha?.agentBrowserInstanceId).toBeNull()
  })

  it('preserves a deliberate null on a v3 record instead of re-linking', () => {
    // THE migration asymmetry. On v2, null means "field did not exist" and
    // must be back-filled; on v3 it means "the operator closed the linked
    // tab" and must survive. Without the version bump this round-trip would
    // silently re-link b1 on every restart and the agent would inherit a
    // page the operator had deliberately taken away from it.
    const parsed = parseSurfacePersisted({
      version: 3,
      pinnedTabs: ['plan'],
      notification: null,
      conversations: { alpha: { tabs: [browser('b1')], activeTabId: null, visible: false, agentBrowserInstanceId: null } },
    })
    expect((parsed as { conversations: Record<string, { agentBrowserInstanceId: string | null }> }).conversations.alpha?.agentBrowserInstanceId).toBeNull()
  })

  it('repairs a pointer that names a tab which no longer exists', () => {
    const parsed = parseSurfacePersisted({
      version: 3,
      pinnedTabs: ['plan'],
      notification: null,
      conversations: { alpha: { tabs: [browser('b1')], activeTabId: null, visible: false, agentBrowserInstanceId: 'gone' } },
    })
    expect((parsed as { conversations: Record<string, { agentBrowserInstanceId: string | null }> }).conversations.alpha?.agentBrowserInstanceId).toBe('b1')
  })

  it('round-trips the pointer and drops it when its tab is gone', () => {
    const kept = serializeSurface(['plan'], null, {
      alpha: { tabs: [browser('b1'), browser('b2')], activeTabId: null, visible: false, agentBrowserInstanceId: 'b2' },
    })
    expect(kept.conversations.alpha?.agentBrowserInstanceId).toBe('b2')
    expect(parseSurfacePersisted(JSON.parse(JSON.stringify(kept)))).toEqual(kept)

    const dropped = serializeSurface(['plan'], null, {
      alpha: { tabs: [browser('b1')], activeTabId: null, visible: false, agentBrowserInstanceId: 'vanished' },
    })
    expect(dropped.conversations.alpha?.agentBrowserInstanceId).toBeNull()
  })

  it('rejects a v2 payload as a new write', () => {
    expect(validateSurfacePersisted(v2([browser('b1')]))).toBe(false)
    expect(validateSurfacePersisted(emptySurfacePersisted())).toBe(true)
  })
})

describe('browser emulation persistence', () => {
  const emulated: SurfaceTab = { ...browser('b1'), emulation: { device: 'iPhone 15', width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true } } as SurfaceTab

  it('round-trips a browser emulation state', () => {
    const persisted = serializeSurface(['plan'], null, {
      alpha: { tabs: [emulated], activeTabId: null, visible: false, agentBrowserInstanceId: 'b1' },
    })
    expect(parseSurfacePersisted(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted)
  })

  it('drops a malformed emulation while keeping the tab', () => {
    // Losing a viewport override is recoverable; losing the tab (and with it
    // the pointer that names it) is not. So a bad emulation is dropped, never
    // fatal to the descriptor.
    const parsed = parseSurfacePersisted({
      version: 3,
      pinnedTabs: ['plan'],
      notification: null,
      conversations: {
        alpha: {
          tabs: [{ kind: 'browser', instanceId: 'b1', url: 'https://example.org', mode: 'browse', emulation: { width: 'wide' } }],
          activeTabId: null,
          visible: false,
          agentBrowserInstanceId: 'b1',
        },
      },
    })
    const tabs = (parsed as { conversations: Record<string, { tabs: SurfaceTab[] }> }).conversations.alpha?.tabs ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).not.toHaveProperty('emulation')
  })
})

describe('linked browser ordering', () => {
  it('sorts the linked browser ahead of the other browser tabs', () => {
    const ordered = normalizeTabs([browser('b1'), browser('b2'), browser('b3')], 'b3')
    expect(ordered.map((tab) => tab.kind === 'browser' && tab.instanceId)).toEqual(['b3', 'b1', 'b2'])
  })

  it('keeps non-browser tabs in place while reordering browsers', () => {
    // The linked browser takes over the first BROWSER slot, not the first
    // slot: a terminal the operator parked between two browsers must not be
    // shuffled by an agent link change.
    const terminal: SurfaceTab = { kind: 'terminal', id: 'terminal:t1', instanceId: 't1', cwd: '/repo', title: 'zsh' }
    const ordered = normalizeTabs([browser('b1'), terminal, browser('b2')], 'b2')
    expect(ordered.map((tab) => tab.id)).toEqual(['browser:b2', 'terminal:t1', 'browser:b1'])
  })

  it('is a no-op when the pointer is null or already first', () => {
    expect(normalizeTabs([browser('b1'), browser('b2')], null).map((tab) => tab.id)).toEqual(['browser:b1', 'browser:b2'])
    expect(normalizeTabs([browser('b1'), browser('b2')], 'b1').map((tab) => tab.id)).toEqual(['browser:b1', 'browser:b2'])
  })

  it('never promotes the linked browser into the global pin set', () => {
    const ordered = normalizeTabs([{ kind: 'singleton', id: 'diff' }, browser('b1')], 'b1')
    // Singletons keep the left-most positions; the linked browser stays in
    // the dynamic region. It is a conversation-local pin, not a global one.
    expect(ordered[0]).toEqual({ kind: 'singleton', id: 'diff' })
  })
})
