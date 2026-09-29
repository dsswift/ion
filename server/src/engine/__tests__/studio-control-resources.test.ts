/**
 * Studio's own resource traffic (a control kind `ion-studio.*`, or the
 * operator focus Studio publishes for extensions) never reaches a mobile
 * client: it is absent from the manifest a mobile client lists, and it is not
 * forwarded on the mobile wire.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }))

import { ResourceCatalog } from '../resource-catalog'
import { isStudioOnlyEngineEvent } from '../event-wiring-mobile-filter'

const item = (id: string, kind: string) => ({ id, kind, producer: 'cos2', title: id, content: '{}', createdAt: '2026-01-01T00:00:00Z' })

describe('studio resource traffic', () => {
  it('are left out of the manifest a mobile client lists, while other kinds stay', () => {
    const catalog = new ResourceCatalog()
    catalog.applySnapshot('tab-1', 'ion-studio.composer-action', [item('briefing', 'ion-studio.composer-action')] as never, undefined)
    catalog.applySnapshot('tab-1', 'desktop.focus', [item('focus-1', 'desktop.focus')] as never, undefined)
    catalog.applySnapshot('tab-1', 'briefing', [item('b1', 'briefing')] as never, undefined)
    const manifest = catalog.manifest(() => false)
    expect(Object.keys(manifest)).toEqual(['briefing'])
  })

  it('are the resource classes held back from the mobile wire', () => {
    expect(isStudioOnlyEngineEvent({ type: 'engine_resource_snapshot', resourceKind: 'ion-studio.composer-action' })).toBe(true)
    expect(isStudioOnlyEngineEvent({ type: 'engine_resource_delta', resourceKind: 'ion-studio.composer-action' })).toBe(true)
    expect(isStudioOnlyEngineEvent({ type: 'engine_resource_delta', resourceKind: 'desktop.focus' })).toBe(true)
    expect(isStudioOnlyEngineEvent({ type: 'engine_resource_delta', resourceKind: 'briefing' })).toBe(false)
    expect(isStudioOnlyEngineEvent({ type: 'engine_text_delta' })).toBe(false)
  })
})
