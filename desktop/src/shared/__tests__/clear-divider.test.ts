/**
 * Tests for the shared /clear divider helpers.
 *
 * `formatClearDivider`, `isClearDivider`, and `buildClearDividerRemoteEvent`
 * are the contract surface that keeps the four /clear paths
 * (desktop CLI, desktop engine, iOS CLI, iOS engine) producing the same
 * UX. Drift between processes would silently break the divider.
 */

import { describe, it, expect } from 'vitest'
import {
  formatClearDivider,
  isClearDivider,
  buildClearDividerRemoteEvent,
} from '../clear-divider'

describe('formatClearDivider', () => {
  it('emits the `── Cleared at <time> ──` sentinel shape', () => {
    const out = formatClearDivider(new Date('2024-01-01T15:42:00'))
    expect(out.startsWith('── Cleared at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })
})

describe('isClearDivider', () => {
  it('recognises a divider string produced by formatClearDivider', () => {
    expect(isClearDivider(formatClearDivider(new Date()))).toBe(true)
  })

  it('rejects unrelated system messages', () => {
    expect(isClearDivider('Conversation cleared.')).toBe(false)
    expect(isClearDivider('Error: something went wrong')).toBe(false)
    expect(isClearDivider('')).toBe(false)
  })

  it('matches even on locale-altered time formats (only the prefix matters)', () => {
    // The toLocaleTimeString output varies by locale; the sentinel is the
    // `── Cleared` prefix, not the time format. Construct synthetic strings
    // to make sure the check survives that variation.
    expect(isClearDivider('── Cleared at 3:42 PM ──')).toBe(true)
    expect(isClearDivider('── Cleared at 15:42 ──')).toBe(true)
    expect(isClearDivider('── Cleared anything ──')).toBe(true)
  })
})

describe('buildClearDividerRemoteEvent', () => {
  const at = new Date('2024-06-15T10:30:00')

  describe('engine-tab key (tabId:instanceId)', () => {
    it('produces an engine_harness_message envelope', () => {
      const ev = buildClearDividerRemoteEvent('tab-abc:inst-xyz', at)
      expect(ev.type).toBe('engine_harness_message')
      if (ev.type !== 'engine_harness_message') return // discriminate
      expect(ev.tabId).toBe('tab-abc')
      expect(ev.instanceId).toBe('inst-xyz')
      expect(ev.message.startsWith('── Cleared at ')).toBe(true)
      expect(ev.source).toBe('clear')
    })

    it('splits on the FIRST colon so an instance id with a colon survives', () => {
      // Defensive: if an instance id ever contained a colon, the split
      // would still resolve tabId correctly. (Real instance ids are UUIDs
      // — no colons — but the split semantics matter for future-proofing.)
      const ev = buildClearDividerRemoteEvent('tab-abc:weird:inst', at)
      if (ev.type !== 'engine_harness_message') {
        throw new Error('expected engine_harness_message envelope')
      }
      expect(ev.tabId).toBe('tab-abc')
      expect(ev.instanceId).toBe('weird:inst')
    })
  })

  describe('CLI-tab key (bare tabId)', () => {
    it('produces a message_added envelope with role=system', () => {
      const ev = buildClearDividerRemoteEvent('tab-cli', at)
      expect(ev.type).toBe('message_added')
      if (ev.type !== 'message_added') return
      expect(ev.tabId).toBe('tab-cli')
      expect(ev.message.role).toBe('system')
      expect(ev.message.content.startsWith('── Cleared at ')).toBe(true)
      expect(ev.message.source).toBe('desktop')
      expect(ev.message.timestamp).toBe(at.getTime())
      expect(ev.message.id).toBe(`clear-${at.getTime()}`)
    })
  })
})
