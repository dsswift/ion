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
