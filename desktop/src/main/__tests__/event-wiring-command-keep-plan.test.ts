/**
 * Pins that the `/clear --keep-plan` outcome fields survive the engine →
 * normalized command_result translation. The renderer draws the keep-plan
 * divider from these forwarded fields, so dropping them silently regresses the
 * notice to the plain "Cleared" divider.
 */

import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '../../shared/types'
import { handleCommandEvent } from '../event-wiring-command'

function captureNormalized(): { sent: Array<{ tabId: string; event: NormalizedEvent }>; fn: (tabId: string, event: NormalizedEvent) => void } {
  const sent: Array<{ tabId: string; event: NormalizedEvent }> = []
  return { sent, fn: vi.fn((tabId: string, event: NormalizedEvent) => { sent.push({ tabId, event }) }) }
}

describe('handleCommandEvent — /clear --keep-plan outcome', () => {
  it('forwards clearKeepPlan + clearKeptPlanSlug to the normalized command_result', () => {
    const { sent, fn } = captureNormalized()
    const handled = handleCommandEvent(
      'tab-1',
      { type: 'engine_command_result', command: 'clear', clearKeepPlan: true, clearKeptPlanSlug: 'happy-jumping-rabbit' },
      fn,
    )
    expect(handled).toBe(true)
    const evt = sent[0].event as Extract<NormalizedEvent, { type: 'command_result' }>
    expect(evt.type).toBe('command_result')
    expect(evt.clearKeepPlan).toBe(true)
    expect(evt.clearKeptPlanSlug).toBe('happy-jumping-rabbit')
  })

  it('forwards the no-plan-kept outcome (flag set, empty slug)', () => {
    const { sent, fn } = captureNormalized()
    handleCommandEvent(
      'tab-2',
      { type: 'engine_command_result', command: 'clear', clearKeepPlan: true, clearKeptPlanSlug: '' },
      fn,
    )
    const evt = sent[0].event as Extract<NormalizedEvent, { type: 'command_result' }>
    expect(evt.clearKeepPlan).toBe(true)
    expect(evt.clearKeptPlanSlug).toBe('')
  })

  it('leaves the fields undefined for an ordinary /clear', () => {
    const { sent, fn } = captureNormalized()
    handleCommandEvent('tab-3', { type: 'engine_command_result', command: 'clear' }, fn)
    const evt = sent[0].event as Extract<NormalizedEvent, { type: 'command_result' }>
    expect(evt.clearKeepPlan).toBeUndefined()
    expect(evt.clearKeptPlanSlug).toBeUndefined()
  })
})
