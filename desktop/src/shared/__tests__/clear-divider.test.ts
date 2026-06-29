/**
 * Tests for the shared scrollback divider helpers.
 *
 * `formatClearDivider`, `isClearDivider`, `formatSessionStartDivider`,
 * `formatPlanCreatedDivider`, `isPlanCreatedDivider`,
 * `formatSteerAppliedDivider`, `isSteerAppliedDivider`,
 * `buildClearDividerRemoteEvent`, and `buildDividerRemoteEvent`
 * are the contract surface that keeps divider paths
 * (desktop CLI, desktop engine, iOS CLI, iOS engine) producing the same
 * UX. Drift between processes would silently break the divider.
 */

import { describe, it, expect } from 'vitest'
import {
  formatClearDivider,
  isClearDivider,
  formatImplementDivider,
  isImplementDivider,
  planSlugFromPath,
  formatSessionStartDivider,
  formatPlanCreatedDivider,
  isPlanCreatedDivider,
  formatPlanUpdatedDivider,
  isPlanUpdatedDivider,
  formatSteerAppliedDivider,
  isSteerAppliedDivider,
  buildClearDividerRemoteEvent,
  buildDividerRemoteEvent,
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

describe('formatImplementDivider', () => {
  it('emits the `── Implementing plan at <time> ──` sentinel shape', () => {
    const out = formatImplementDivider(new Date('2024-01-01T15:42:00'))
    expect(out.startsWith('── Implementing plan at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
    expect(out.includes(' · ')).toBe(false)
  })

  it('includes the slug when provided (same shape as plan-created/updated)', () => {
    const out = formatImplementDivider(new Date('2024-01-01T15:42:00'), 'frosty-twirling-finch')
    expect(out.startsWith('── Implementing plan at ')).toBe(true)
    expect(out.includes(' · frosty-twirling-finch')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })

  it('omits the slug separator when slug is empty', () => {
    const out = formatImplementDivider(new Date('2024-01-01T15:42:00'), '')
    expect(out.includes(' · ')).toBe(false)
  })

  it('is detected by isImplementDivider, with and without slug', () => {
    expect(isImplementDivider(formatImplementDivider(new Date()))).toBe(true)
    expect(isImplementDivider(formatImplementDivider(new Date(), 'slug'))).toBe(true)
  })

  it('is not detected as a clear divider', () => {
    expect(isClearDivider(formatImplementDivider(new Date()))).toBe(false)
  })

  it('starts with the generic `──` prefix used for divider rendering', () => {
    const out = formatImplementDivider(new Date())
    expect(out.startsWith('──')).toBe(true)
  })
})

describe('isImplementDivider', () => {
  it('rejects unrelated dividers and system messages', () => {
    expect(isImplementDivider(formatClearDivider(new Date()))).toBe(false)
    expect(isImplementDivider(formatPlanCreatedDivider(new Date(), 'slug'))).toBe(false)
    expect(isImplementDivider(formatPlanUpdatedDivider(new Date(), 'slug'))).toBe(false)
    expect(isImplementDivider(formatSessionStartDivider(new Date()))).toBe(false)
    expect(isImplementDivider('')).toBe(false)
  })
})

describe('planSlugFromPath', () => {
  it('returns the basename minus the .md extension', () => {
    expect(planSlugFromPath('/home/u/.ion/plans/happy-jumping-rabbit.md')).toBe('happy-jumping-rabbit')
  })

  it('handles Windows-style separators', () => {
    expect(planSlugFromPath('C:\\\\plans\\\\frosty-finch.md')).toBe('frosty-finch')
  })

  it('round-trips a legacy hex filename as the raw hex string', () => {
    expect(planSlugFromPath('/p/ef072eb2660d.md')).toBe('ef072eb2660d')
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(planSlugFromPath(null)).toBe('')
    expect(planSlugFromPath(undefined)).toBe('')
    expect(planSlugFromPath('')).toBe('')
  })
})

describe('buildClearDividerRemoteEvent', () => {
  const at = new Date('2024-06-15T10:30:00')

  describe('engine-tab key (tabId:instanceId)', () => {
    it('produces an engine_harness_message envelope', () => {
      const ev = buildClearDividerRemoteEvent('tab-abc:inst-xyz', at)
      expect(ev.type).toBe('desktop_harness_message')
      if (ev.type !== 'desktop_harness_message') return // discriminate
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
      if (ev.type !== 'desktop_harness_message') {
        throw new Error('expected engine_harness_message envelope')
      }
      expect(ev.tabId).toBe('tab-abc')
      expect(ev.instanceId).toBe('weird:inst')
    })
  })

  describe('CLI-tab key (bare tabId)', () => {
    it('produces a message_added envelope with role=system', () => {
      const ev = buildClearDividerRemoteEvent('tab-cli', at)
      expect(ev.type).toBe('desktop_message_added')
      if (ev.type !== 'desktop_message_added') return
      expect(ev.tabId).toBe('tab-cli')
      expect(ev.message.role).toBe('system')
      expect(ev.message.content.startsWith('── Cleared at ')).toBe(true)
      expect(ev.message.source).toBe('desktop')
      expect(ev.message.timestamp).toBe(at.getTime())
      expect(ev.message.id).toBe(`clear-${at.getTime()}`)
    })
  })
})

describe('formatSessionStartDivider', () => {
  it('emits the `── Session started at <time> ──` sentinel shape', () => {
    const out = formatSessionStartDivider(new Date('2024-01-01T15:42:00'))
    expect(out.startsWith('── Session started at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })

  it('starts with the generic `──` prefix used for divider rendering', () => {
    expect(formatSessionStartDivider(new Date()).startsWith('──')).toBe(true)
  })

  it('is not detected as a clear divider or plan-created divider', () => {
    const out = formatSessionStartDivider(new Date())
    expect(isClearDivider(out)).toBe(false)
    expect(isPlanCreatedDivider(out)).toBe(false)
  })
})

describe('formatPlanCreatedDivider', () => {
  it('emits the `── Plan created at <time> ──` shape without slug', () => {
    const out = formatPlanCreatedDivider(new Date('2024-01-01T15:42:00'))
    expect(out.startsWith('── Plan created at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
    expect(out.includes(' · ')).toBe(false)
  })

  it('includes the slug when provided', () => {
    const out = formatPlanCreatedDivider(new Date('2024-01-01T15:42:00'), 'frosty-twirling-finch')
    expect(out.startsWith('── Plan created at ')).toBe(true)
    expect(out.includes(' · frosty-twirling-finch')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })

  it('is detected by isPlanCreatedDivider', () => {
    expect(isPlanCreatedDivider(formatPlanCreatedDivider(new Date()))).toBe(true)
    expect(isPlanCreatedDivider(formatPlanCreatedDivider(new Date(), 'slug'))).toBe(true)
  })
})

describe('isPlanCreatedDivider', () => {
  it('rejects unrelated dividers and system messages', () => {
    expect(isPlanCreatedDivider(formatClearDivider(new Date()))).toBe(false)
    expect(isPlanCreatedDivider(formatImplementDivider(new Date()))).toBe(false)
    expect(isPlanCreatedDivider(formatSessionStartDivider(new Date()))).toBe(false)
    expect(isPlanCreatedDivider('Error: something')).toBe(false)
    expect(isPlanCreatedDivider('')).toBe(false)
  })

  it('does NOT match a plan-updated divider (created ≠ updated)', () => {
    expect(isPlanCreatedDivider(formatPlanUpdatedDivider(new Date(), 'slug'))).toBe(false)
  })
})

describe('formatPlanUpdatedDivider', () => {
  it('emits the `── Plan updated at <time> ──` shape without slug', () => {
    const out = formatPlanUpdatedDivider(new Date('2024-01-01T15:42:00'))
    expect(out.startsWith('── Plan updated at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
    expect(out.includes(' · ')).toBe(false)
  })

  it('includes the slug when provided', () => {
    const out = formatPlanUpdatedDivider(new Date('2024-01-01T15:42:00'), 'frosty-twirling-finch')
    expect(out.startsWith('── Plan updated at ')).toBe(true)
    expect(out.includes(' · frosty-twirling-finch')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })

  it('is detected by isPlanUpdatedDivider', () => {
    expect(isPlanUpdatedDivider(formatPlanUpdatedDivider(new Date()))).toBe(true)
    expect(isPlanUpdatedDivider(formatPlanUpdatedDivider(new Date(), 'slug'))).toBe(true)
  })
})

describe('isPlanUpdatedDivider', () => {
  it('rejects unrelated dividers and system messages', () => {
    expect(isPlanUpdatedDivider(formatClearDivider(new Date()))).toBe(false)
    expect(isPlanUpdatedDivider(formatImplementDivider(new Date()))).toBe(false)
    expect(isPlanUpdatedDivider(formatSessionStartDivider(new Date()))).toBe(false)
    expect(isPlanUpdatedDivider('Error: something')).toBe(false)
    expect(isPlanUpdatedDivider('')).toBe(false)
  })

  it('does NOT match a plan-created divider (updated ≠ created)', () => {
    expect(isPlanUpdatedDivider(formatPlanCreatedDivider(new Date(), 'slug'))).toBe(false)
  })
})

describe('formatSteerAppliedDivider', () => {
  it('emits the `── Steer applied at <time> · <N> chars ──` shape', () => {
    const out = formatSteerAppliedDivider(new Date('2024-01-01T15:42:00'), 27)
    expect(out.startsWith('── Steer applied at ')).toBe(true)
    expect(out.includes(' · 27 chars ──')).toBe(true)
  })

  it('starts with the generic `──` prefix used for divider rendering', () => {
    expect(formatSteerAppliedDivider(new Date(), 1).startsWith('──')).toBe(true)
  })

  it('is detected by isSteerAppliedDivider', () => {
    expect(isSteerAppliedDivider(formatSteerAppliedDivider(new Date(), 42))).toBe(true)
  })

  it('is not detected as a clear/plan-created/session-start divider', () => {
    const out = formatSteerAppliedDivider(new Date(), 42)
    expect(isClearDivider(out)).toBe(false)
    expect(isPlanCreatedDivider(out)).toBe(false)
  })
})

describe('isSteerAppliedDivider', () => {
  it('rejects unrelated dividers and system messages', () => {
    expect(isSteerAppliedDivider(formatClearDivider(new Date()))).toBe(false)
    expect(isSteerAppliedDivider(formatImplementDivider(new Date()))).toBe(false)
    expect(isSteerAppliedDivider(formatSessionStartDivider(new Date()))).toBe(false)
    expect(isSteerAppliedDivider(formatPlanCreatedDivider(new Date()))).toBe(false)
    expect(isSteerAppliedDivider('Error: something')).toBe(false)
    expect(isSteerAppliedDivider('')).toBe(false)
  })
})

describe('buildDividerRemoteEvent', () => {
  const at = new Date('2024-06-15T10:30:00')

  it('produces engine_harness_message for engine-tab keys', () => {
    const content = '── Session started at 10:30 AM ──'
    const ev = buildDividerRemoteEvent('tab-abc:inst-xyz', content, at)
    expect(ev.type).toBe('desktop_harness_message')
    if (ev.type !== 'desktop_harness_message') return
    expect(ev.tabId).toBe('tab-abc')
    expect(ev.instanceId).toBe('inst-xyz')
    expect(ev.message).toBe(content)
  })

  it('produces message_added for CLI-tab keys', () => {
    const content = '── Implementing plan at 10:30 AM ──'
    const ev = buildDividerRemoteEvent('tab-cli', content, at)
    expect(ev.type).toBe('desktop_message_added')
    if (ev.type !== 'desktop_message_added') return
    expect(ev.tabId).toBe('tab-cli')
    expect(ev.message.role).toBe('system')
    expect(ev.message.content).toBe(content)
  })

  it('buildClearDividerRemoteEvent delegates to buildDividerRemoteEvent', () => {
    // Both should produce identical structure for the same key
    const legacy = buildClearDividerRemoteEvent('tab-abc:inst-xyz', at)
    const general = buildDividerRemoteEvent('tab-abc:inst-xyz', formatClearDivider(at), at)
    expect(legacy).toEqual(general)
  })
})
