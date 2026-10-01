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
