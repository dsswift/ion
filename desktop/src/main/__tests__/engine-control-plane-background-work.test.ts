import { describe, expect, it, vi } from 'vitest'
import { handleStreamSignalEvent } from '../engine-control-plane-stream'

const work = {
  kind: 'background_task_completion',
  deliveryMode: 'wake',
  items: [{ id: 'bash-1', source: 'bash', label: 'npm test', status: 'completed', exitCode: 0, elapsedMs: 800 }],
}

describe('handleStreamSignalEvent — background_work_delivered', () => {
  it('maps canonical durable delivery payload to normalized event', () => {
    const ctx = { emit: vi.fn() } as any
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_background_work_delivered',
      backgroundWorkDelivered: { entryId: 'entry-1', content: 'Background command bash-1 (completed).', work },
    } as any)).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab', {
      type: 'background_work_delivered',
      entryId: 'entry-1',
      content: 'Background command bash-1 (completed).',
      work,
    })
  })

  it('does not fabricate a delivery row when engine omitted durable payload', () => {
    const ctx = { emit: vi.fn() } as any
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_background_work_delivered',
    } as any)).toBe(true)
    expect(ctx.emit).not.toHaveBeenCalled()
  })
})
