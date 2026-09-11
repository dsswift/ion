import { describe, expect, it, vi } from 'vitest'
import { handleStreamSignalEvent } from '../engine-control-plane-stream'

/**
 * engine_dispatch_lost — the engine's notice that a dispatch was running when
 * the engine process died and is unrecoverable.
 *
 * Before this arm existed the desktop declared the event type and consumed it
 * nowhere: two agents could die mid-run after real work and the operator got
 * no notice at all. The conversation simply went quiet.
 */
describe('handleStreamSignalEvent — dispatch_lost', () => {
  it('forwards the orphan identity to the renderer', () => {
    const ctx = { emit: vi.fn() } as any
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_dispatch_lost',
      dispatchLost: {
        dispatchId: 'dispatch-agent-2-1789044109138-097110fdb688',
        agentName: 'agent-2',
        childConversationId: 'conv-child-1',
      },
    } as any)).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab', {
      type: 'dispatch_lost',
      dispatchId: 'dispatch-agent-2-1789044109138-097110fdb688',
      agentName: 'agent-2',
      childConversationId: 'conv-child-1',
    })
  })

  it('drops a bare announcement the engine could not attribute', () => {
    // "agent was lost" with no agent is worse than silence, and there is
    // nothing for a consumer to act on.
    const ctx = { emit: vi.fn() } as any
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_dispatch_lost',
    } as any)).toBe(true)
    expect(ctx.emit).not.toHaveBeenCalled()
  })
})
