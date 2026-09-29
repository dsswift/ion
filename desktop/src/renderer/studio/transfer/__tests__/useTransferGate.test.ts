/**
 * useTransferGate — the Transfer row is enabled for an idle conversation
 * that is not mid-transfer, with or without another machine connected: the
 * machine it is on is a destination too.
 */
import { describe, expect, it } from 'vitest'
import { useTransferGate } from '../useTransferGate'

describe('useTransferGate', () => {
  it('enables an idle conversation that is not mid-transfer', () => {
    expect(useTransferGate({ status: 'idle', sealPending: null })).toEqual({ disabled: false })
  })
  it('disables a busy conversation, or one already moving', () => {
    expect(useTransferGate({ status: 'running', sealPending: null }).disabled).toBe(true)
    expect(useTransferGate({ status: 'idle', sealPending: { targetEnvironmentId: 'env-b', since: 1 } }).disabled).toBe(true)
  })
})
