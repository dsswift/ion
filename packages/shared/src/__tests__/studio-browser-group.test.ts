import { describe, expect, it } from 'vitest'
import { browserGroup, isBrowserTabId, resolveActiveBrowserInstance } from '../studio-browser-group'
import { parseSurfacePersisted, serializeSurface, validateSurfacePersisted } from '../studio-surface-persistence'
import type { SurfaceTab } from '../studio-surface-types'

function browser(instanceId: string): SurfaceTab {
  return { kind: 'browser', id: `browser:${instanceId}`, instanceId, url: `https://${instanceId}.example.org`, title: instanceId, mode: 'browse', sessionMode: 'shared' }
}
const file: SurfaceTab = { kind: 'file', id: 'file:/repo/a.ts', filePath: '/repo/a.ts', dir: '/repo' }
const terminal: SurfaceTab = { kind: 'terminal', id: 'terminal:t1', instanceId: 't1', cwd: '/repo', title: 'Terminal 1' }

describe('browserGroup', () => {
  it('collapses interleaved browser documents into one slot at the first browser position', () => {
    const tabs = [file, browser('b1'), terminal, browser('b2')]
    const group = browserGroup(tabs, 'file:/repo/a.ts', null, null)
    expect(group.slotIndex).toBe(1)
    expect(group.documents.map((tab) => tab.instanceId)).toEqual(['b1', 'b2'])
  })

  it('shows the active browser document over the remembered one', () => {
    const tabs = [browser('b1'), browser('b2')]
    expect(browserGroup(tabs, 'browser:b2', 'b1', null).shown?.instanceId).toBe('b2')
  })

  it('shows the remembered document when a non-browser tab is active', () => {
    const tabs = [browser('b1'), browser('b2'), file]
    expect(browserGroup(tabs, 'file:/repo/a.ts', 'b2', null).shown?.instanceId).toBe('b2')
  })

  it('falls back to the first document when the memory is stale', () => {
    const tabs = [browser('b1'), browser('b2')]
    expect(browserGroup(tabs, 'file:/repo/a.ts', 'gone', null).shown?.instanceId).toBe('b1')
    expect(resolveActiveBrowserInstance(tabs, null, undefined)).toBe('b1')
  })

  it('puts the agent-linked document first', () => {
    const tabs = [browser('b1'), browser('b2'), browser('b3')]
    expect(browserGroup(tabs, null, null, 'b3').documents.map((tab) => tab.instanceId)).toEqual(['b3', 'b1', 'b2'])
  })

  it('is empty for a conversation with no browser', () => {
    expect(browserGroup([file, terminal], 'file:/repo/a.ts', 'b1', 'b1')).toEqual({ documents: [], shown: null, slotIndex: -1 })
    expect(resolveActiveBrowserInstance([file], 'file:/repo/a.ts', 'b1')).toBeNull()
  })

  it('recognises browser tab ids', () => {
    expect(isBrowserTabId('browser:b1')).toBe(true)
    expect(isBrowserTabId('file:/x')).toBe(false)
    expect(isBrowserTabId(null)).toBe(false)
  })
})

describe('activeBrowserInstanceId persistence', () => {
  function row(over: Record<string, unknown>) {
    return { version: 4, pinnedTabs: [], notification: null, scratchProjects: {}, conversations: { alpha: { tabs: [file, browser('b1'), browser('b2')], activeTabId: 'file:/repo/a.ts', visible: true, width: null, agentBrowserInstanceId: null, ...over } } }
  }
  function parsed(raw: unknown): string | null | undefined {
    const result = parseSurfacePersisted(raw)
    return result?.version === 4 ? result.conversations.alpha?.activeBrowserInstanceId : undefined
  }

  it('resolves an absent field from the active tab, then the first browser, and still validates', () => {
    const legacy = row({ activeTabId: 'browser:b2' })
    expect(validateSurfacePersisted(legacy)).toBe(true)
    expect(parsed(legacy)).toBe('b2')
    expect(parsed(row({}))).toBe('b1')
    expect(parsed(row({ activeTabId: null }))).toBe('b1')
  })

  it('keeps a stored memory that names a live document and repairs one that does not', () => {
    expect(parsed(row({ activeBrowserInstanceId: 'b2' }))).toBe('b2')
    expect(parsed(row({ activeBrowserInstanceId: 'closed' }))).toBe('b1')
  })

  it('round-trips the memory and a zoom level through serialize', () => {
    const zoomed: SurfaceTab = { ...browser('b2'), zoomLevel: 1.5 } as SurfaceTab
    const out = serializeSurface([], null, {
      alpha: { tabs: [file, browser('b1'), zoomed], activeTabId: 'file:/repo/a.ts', visible: true, width: null, agentBrowserInstanceId: null, activeBrowserInstanceId: 'b2' },
    })
    expect(out.conversations.alpha?.activeBrowserInstanceId).toBe('b2')
    const back = parseSurfacePersisted(out)
    expect(back?.version === 4 && back.conversations.alpha?.tabs[2]).toMatchObject({ instanceId: 'b2', zoomLevel: 1.5 })
  })

  it('drops a zoom level that is zero or out of range', () => {
    const out = parseSurfacePersisted(row({ tabs: [{ ...browser('b1'), zoomLevel: 0 }, { ...browser('b2'), zoomLevel: 99 }] }))
    expect(out?.version === 4 && out.conversations.alpha?.tabs).toEqual([
      expect.not.objectContaining({ zoomLevel: expect.anything() }),
      expect.objectContaining({ zoomLevel: 8.8 }),
    ])
  })
})
