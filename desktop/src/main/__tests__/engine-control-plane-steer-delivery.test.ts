import { describe, expect, it, vi } from 'vitest'
import { handleStreamSignalEvent } from '../engine-control-plane-stream'

/**
 * Steer signal semantics at the desktop's engine-wire boundary.
 *
 * `engine_steer_injected` means a LIVE run-loop checkpoint drained a steer,
 * while `engine_steer_degraded` means ctx.steerSelf found no owning run and
 * accepted a fresh prompt. They deliberately become distinct normalized events
 * so the renderer can keep live pending-bubble reconciliation exclusive to the
 * first case.
 */
describe('handleStreamSignalEvent — steer delivery semantics', () => {
  function context() {
    return { emit: vi.fn() } as any
  }

  it('maps a live drain to steer_injected with the live length field', () => {
    const ctx = context()
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_steer_injected', steerMessageLength: 17,
    } as any)).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab', {
      type: 'steer_injected', messageLength: 17,
    })
  })

  // REGRESSION: engine_steer_injected's correlation fields (steerClientMessageId,
  // steerEntryId — the engine's own field names) were dropped by the desktop's
  // engine_event -> internal steer_injected translation, even though iOS's
  // handleEngineSteerInjected has needed them since the exact-rewind-entry fix
  // (learn exact rewind entry from steer confirmations). Without them, a
  // client-originated steer could never be resolved to its exact optimistic
  // bubble or adopt the durable entry id for a later rewind by id.
  it('forwards the correlation ids the engine attaches to a live drain', () => {
    const ctx = context()
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_steer_injected',
      steerMessageLength: 17,
      steerClientMessageId: 'msg-abc123',
      steerEntryId: '9f2a1b7c',
      steerKind: 'user',
      steerMachineAuthored: false,
    } as any)).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab', {
      type: 'steer_injected',
      messageLength: 17,
      clientMessageId: 'msg-abc123',
      entryId: '9f2a1b7c',
      kind: 'user',
      machineAuthored: false,
    })
  })

  it('maps an idle fallback to steer_degraded without aliasing the live event', () => {
    const ctx = context()
    expect(handleStreamSignalEvent(ctx, 'tab', {} as any, {
      type: 'engine_steer_degraded', steerDegradedMessageLength: 23,
    } as any)).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab', {
      type: 'steer_degraded', messageLength: 23,
    })
    expect(ctx.emit).not.toHaveBeenCalledWith('event', 'tab', {
      type: 'steer_injected', messageLength: 23,
    })
  })
})
