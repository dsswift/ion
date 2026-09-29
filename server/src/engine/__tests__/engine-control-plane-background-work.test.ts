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

// The live start event is the client's FIRST notice that a task exists, and at
// that instant the transcript tool row has no backgroundTaskId of its own — the
// tool_result carrying it has not arrived. `toolId` is therefore the only key
// that can bind the task to its row on first paint, and BackgroundWorkGroup
// matches on it (see BackgroundWorkGroup.test.tsx, "matches a start event to
// its tool row before tool-end provides a task id").
//
// The mapping used to rebuild the payload field by field and omit toolId, so
// that fallback had nothing to match and the live Bash group stayed hidden.
//
// Revert-check: drop `toolId: task.toolId` from the engine_background_task_started
// arm in engine-control-plane-stream.ts and this goes red.
describe('handleStreamSignalEvent — background_task_started', () => {
  it('carries toolId through to the renderer event', () => {
    const ctx = { emit: vi.fn() } as any
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_background_task_started',
      backgroundTaskStarted: {
        taskId: 'bash-1-1789041447216',
        toolId: 'call_8iNFYklf0rjCXGkzXYH99C2v',
        command: 'make test-linux-engine',
        startedAt: 10,
        notifyOnComplete: true,
      },
    } as any)).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab', {
      type: 'background_task_started',
      taskId: 'bash-1-1789041447216',
      toolId: 'call_8iNFYklf0rjCXGkzXYH99C2v',
      command: 'make test-linux-engine',
      startedAt: 10,
      notifyOnComplete: true,
    })
  })
})
