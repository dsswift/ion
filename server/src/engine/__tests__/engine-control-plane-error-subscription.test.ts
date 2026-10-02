/**
 * A provider request that fails while the Provider Subscription has no key
 * applied must say so in the error the conversation shows, on every client:
 * this is where the transcript's error text is made.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../session-meta', () => ({
  conversationExists: vi.fn(() => true),
}))

import { handleEngineEvent } from '../engine-control-plane-events'
import type { TabEntry, EventEmitterContext } from '../engine-control-plane-events'
import type { EngineEvent } from '@ion/shared/types'
import type { ProviderSubscriptionStatus } from '@ion/shared/types-engine-event'

function makeTab(): TabEntry {
  return {
    tabId: 'tab-001',
    status: 'running',
    activeRequestId: 'req-1',
    conversationId: 'conv-1',
    engineSessionStarted: true,
    lastActivityAt: Date.now(),
    promptCount: 1,
    promptCountSinceCheckpoint: 1,
    clearedSinceLastPrompt: false,
    resumedSavedConversation: false,
    permissionMode: 'auto',
    startedAt: Date.now() - 10,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    dispatchRunEpoch: null,
    lastObservedRunEpoch: null,
    dispatchAcknowledged: false,
  }
}

describe('engine_error — Provider Subscription state', () => {
  let ctx: EventEmitterContext
  let errors: Array<{ message: string; providerSubscription?: ProviderSubscriptionStatus }>

  beforeEach(() => {
    errors = []
    ctx = {
      bridge: {
        updateSessionConversationId: vi.fn(),
        startSession: vi.fn().mockResolvedValue({ ok: true }),
        getSessionConfig: vi.fn().mockReturnValue(undefined),
      } as unknown as EventEmitterContext['bridge'],
      emit: (eventName: string, ...args: unknown[]) => {
        const payload = args[1] as { type?: string; message: string; providerSubscription?: ProviderSubscriptionStatus }
        if (eventName === 'event' && payload.type === 'error') errors.push(payload)
      },
      setStatus: vi.fn(),
      checkDrain: vi.fn(),
    }
  })

  function fail(providerSubscription?: ProviderSubscriptionStatus): void {
    const event = { type: 'engine_error', message: 'auth: 401 Unauthorized', providerSubscription } as EngineEvent
    handleEngineEvent(ctx, 'tab-001', makeTab(), event)
  }

  it('names a waiting choice ahead of the provider failure', () => {
    fail({ state: 'selection_required', provider: 'gateway', providerDisplayName: 'Gateway', options: [{ id: 'a', label: 'Standard' }, { id: 'b', label: 'High quota' }] })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/^No Gateway subscription is chosen yet/)
    expect(errors[0].message).toContain('auth: 401 Unauthorized')
    expect(errors[0].providerSubscription?.state).toBe('selection_required')
  })

  it('names a missing subscription ahead of the provider failure', () => {
    fail({ state: 'none', provider: 'gateway', providerDisplayName: 'Gateway' })
    expect(errors[0].message).toMatch(/^The signed-in account has no Gateway subscription/)
    expect(errors[0].message).toContain('auth: 401 Unauthorized')
  })

  it("uses the policy's text for a missing subscription", () => {
    fail({ state: 'none', provider: 'gateway', policyFailure: 'subscription_unavailable', message: 'Open a ticket to request access.' })
    expect(errors[0].message).toBe('Open a ticket to request access.\n\nauth: 401 Unauthorized')
  })

  it('carries the policy failure identifier with the error', () => {
    const event = { type: 'engine_error', message: 'Ask the service desk.', policyFailure: 'model_not_allowed' } as EngineEvent
    handleEngineEvent(ctx, 'tab-001', makeTab(), event)
    expect(errors[0]).toMatchObject({ message: 'Ask the service desk.', policyFailure: 'model_not_allowed' })
    fail()
    expect(errors[1]).not.toHaveProperty('policyFailure')
  })

  it('carries the policy failure identifier with a blocked tool result', () => {
    const results: Array<Record<string, unknown>> = []
    ctx.emit = (eventName: string, ...args: unknown[]) => {
      const payload = args[1] as Record<string, unknown>
      if (eventName === 'event' && payload.type === 'tool_result') results.push(payload)
    }
    handleEngineEvent(ctx, 'tab-001', makeTab(), { type: 'engine_tool_end', toolId: 't1', result: 'Blocked: Ask IT.', isError: true, policyFailure: 'tool_blocked' } as EngineEvent)
    handleEngineEvent(ctx, 'tab-001', makeTab(), { type: 'engine_tool_end', toolId: 't2', result: 'ok' } as EngineEvent)
    expect(results[0]).toMatchObject({ toolId: 't1', policyFailure: 'tool_blocked' })
    expect(results[1]).not.toHaveProperty('policyFailure')
  })

  it('leaves the message alone when no lookup is involved', () => {
    fail()
    expect(errors[0].message).toBe('auth: 401 Unauthorized')
    expect(errors[0].providerSubscription).toBeUndefined()
  })

  it('leaves the message alone for a state that needs nobody', () => {
    fail({ state: 'failed', provider: 'gateway', error: 'lookup timed out' })
    expect(errors[0].message).toBe('auth: 401 Unauthorized')
  })
})
