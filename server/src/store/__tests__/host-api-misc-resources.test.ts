/**
 * `markResourceRead` was a no-op on the server while the desktop's IPC
 * handler persisted and published; the store's mark-read path lost both
 * when it moved. It does what the handler did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({ markReadPersisted: vi.fn(), publishResourceMarkRead: vi.fn(async () => undefined) }))
vi.mock('../../engine/event-wiring-resource-state', () => ({ markReadPersisted: deps.markReadPersisted }))
vi.mock('../../engine/event-wiring-resources', () => ({ publishResourceMarkRead: deps.publishResourceMarkRead }))
vi.mock('../../logger', () => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { markResourceRead } from '../host-api-misc'

beforeEach(() => { deps.markReadPersisted.mockClear(); deps.publishResourceMarkRead.mockClear() })

describe('markResourceRead', () => {
  it('persists the read identity and publishes the mark_read delta', () => {
    markResourceRead('briefing', 'item-1', 'producer-a')
    expect(deps.markReadPersisted).toHaveBeenCalledWith('item-1', 'producer-a', 'briefing')
    expect(deps.publishResourceMarkRead).toHaveBeenCalledWith('briefing', 'item-1', 'producer-a')
  })

  it('a failed publish is logged, never thrown into the store', async () => {
    deps.publishResourceMarkRead.mockRejectedValueOnce(new Error('engine away'))
    expect(() => markResourceRead('briefing', 'item-2')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
