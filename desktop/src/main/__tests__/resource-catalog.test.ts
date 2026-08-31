import { describe, expect, it } from 'vitest'
import type { ResourceItem } from '../../shared/types-engine'
import { ResourceCatalog } from '../resource-catalog'

function item(id: string, producer: string, content = id): ResourceItem {
  return { id, kind: 'briefing', producer, content, createdAt: '2026-01-01T00:00:00Z' }
}

describe('ResourceCatalog', () => {
  it('replaces only explicitly covered producers', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('a', 'one'), item('b', 'two')], ['one', 'two'])
    catalog.applySnapshot('source-a', 'briefing', [item('a2', 'one')], ['one'])
    expect(catalog.bootstrapItems(() => false).map((value) => `${value.producer}:${value.id}`).sort())
      .toEqual(['one:a2', 'two:b'])
  })

  it('clears a producer after a successful empty snapshot', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('a', 'one'), item('b', 'two')], ['one', 'two'])
    catalog.applySnapshot('source-a', 'briefing', [], ['one'])
    expect(catalog.bootstrapItems(() => false).map((value) => value.producer)).toEqual(['two'])
  })

  it('retains state for an ambiguous legacy empty snapshot', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('a', 'one')], ['one'])
    catalog.applySnapshot('source-a', 'briefing', [], undefined)
    expect(catalog.bootstrapItems(() => false)).toHaveLength(1)
  })

  it('keeps same ids from different producers and applies deltas by full identity', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('same', 'one'), item('same', 'two')], ['one', 'two'])
    catalog.applyDelta('briefing', { op: 'update', item: item('same', 'one', 'updated') })
    expect(catalog.getItem('briefing', 'same', 'one')?.content).toBe('updated')
    expect(catalog.getItem('briefing', 'same', 'two')?.content).toBe('same')
  })

  it('combines source snapshots without multiplying repeated copies', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('session-one', 'briefing', [item('a', 'one')], ['one'])
    catalog.applySnapshot('session-two', 'briefing', [item('a', 'one')], ['one'])
    expect(catalog.bootstrapItems(() => false)).toHaveLength(1)
    catalog.applySnapshot('session-one', 'briefing', [item('b', 'one')], ['one'])
    expect(catalog.bootstrapItems(() => false).map((value) => value.id).sort()).toEqual(['a', 'b'])
  })

  it('replaces metadata-only content with a full resource item', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('a', 'one', '')], ['one'])
    catalog.applyFullItem('briefing', item('a', 'one', 'full body'))
    expect(catalog.getItem('briefing', 'a', 'one')?.content).toBe('full body')
  })

  it('retains a full item that arrives before its snapshot', () => {
    const catalog = new ResourceCatalog()
    catalog.applyFullItem('briefing', item('a', 'one', 'full body'))
    catalog.applySnapshot('source-a', 'briefing', [item('a', 'one', '')], ['one'])
    expect(catalog.getItem('briefing', 'a', 'one')?.content).toBe('full body')
  })

  it('projects persisted read state into the iOS manifest', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('a', 'one')], ['one'])
    const manifest = catalog.manifest((id, producer) => id === 'a' && producer === 'one')
    expect(manifest.briefing[0].read).toBe(true)
  })
})

/**
 * Reconnect must not delete desktop-owned state.
 *
 * THE BUG THESE EXIST FOR: `clear()` runs on every engine connect to drop
 * stale ENGINE state — subscription ids and snapshots the producing extension
 * must re-serve. It cleared everything, including `chart`, which the DESKTOP
 * produces, persists to disk, and seeds into this catalog at startup before
 * the engine is connected at all.
 *
 * The observed sequence: hydration seeded 6 charts at 10:28:58, `catalog
 * cleared` fired at 10:29:03 on engine connect, and every catalog read after
 * that returned zero charts. The attachments panel was empty on open and no
 * amount of correct downstream code could recover it, because the engine never
 * supplied those items and so would never resend them.
 */
describe('clear() scoping', () => {
  function chartItem(id: string): ResourceItem {
    return { id, kind: 'chart', producer: 'desktop', content: '{}', createdAt: '2026-01-01T00:00:00Z' }
  }

  it('retains desktop-owned charts across an engine reconnect', () => {
    const catalog = new ResourceCatalog()
    catalog.applyFullItem('chart', chartItem('c1'))
    catalog.applyFullItem('chart', chartItem('c2'))

    catalog.clear()

    expect(catalog.manifest(() => false).chart ?? []).toHaveLength(2)
  })

  it('still drops engine-sourced kinds, which is what clear() is for', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('source-a', 'briefing', [item('b1', 'one')], ['one'])
    catalog.applyFullItem('chart', chartItem('c1'))

    catalog.clear()

    // The briefing must go: its producer re-serves it after reconnect.
    expect(catalog.manifest(() => false).briefing ?? []).toHaveLength(0)
    // The chart must stay: no reconnect can make a local file stale.
    expect(catalog.manifest(() => false).chart ?? []).toHaveLength(1)
  })

  it('leaves a chart reachable by getItem after a clear', () => {
    const catalog = new ResourceCatalog()
    catalog.applyFullItem('chart', chartItem('c1'))
    catalog.clear()
    expect(catalog.getItem('chart', 'c1', 'desktop')).toBeDefined()
  })

  it('keeps charts in bootstrapItems, which is what the panel reads', () => {
    // GET_PERSISTED_RESOURCES serves bootstrapItems; if the clear emptied it,
    // the renderer's first read returns nothing regardless of hydration.
    const catalog = new ResourceCatalog()
    catalog.applyFullItem('chart', chartItem('c1'))
    catalog.applySnapshot('source-a', 'briefing', [item('b1', 'one')], ['one'])

    catalog.clear()

    const kinds = catalog.bootstrapItems(() => false).map((i) => i.kind)
    expect(kinds).toEqual(['chart'])
  })
})
