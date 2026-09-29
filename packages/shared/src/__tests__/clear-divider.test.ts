/**
 * Tests for the shared scrollback divider helpers.
 *
 * `formatClearDivider`, `isClearDivider`, `formatSessionStartDivider`,
 * `formatPlanCreatedDivider`, `isPlanCreatedDivider`,
 * `formatSteerAppliedDivider`, and `isSteerAppliedDivider`
 * are the contract surface that keeps every divider path producing the
 * same UX. Drift between processes would silently break the divider.
 */

import { describe, it, expect } from 'vitest'
import {
  formatClearDivider,
  formatClearKeepPlanDivider,
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
  formatDispatchLostDivider,
  isDispatchLostDivider,
} from '../clear-divider'

describe('formatClearDivider', () => {
  it('emits the `── Cleared at <time> ──` sentinel shape', () => {
    const out = formatClearDivider(new Date('2024-01-01T15:42:00'))
    expect(out.startsWith('── Cleared at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })
})

describe('formatClearKeepPlanDivider', () => {
  const at = new Date('2024-01-01T15:42:00')

  it('names the kept plan slug when one was retained', () => {
    const out = formatClearKeepPlanDivider(at, 'happy-jumping-rabbit')
    expect(out.startsWith('── Cleared at ')).toBe(true)
    expect(out).toContain('plan kept: happy-jumping-rabbit')
    expect(out.endsWith(' ──')).toBe(true)
  })

  it('states no plan was kept when the slug is empty', () => {
    for (const slug of [undefined, null, '']) {
      const out = formatClearKeepPlanDivider(at, slug)
      expect(out).toContain('no plan to keep')
    }
  })

  it('keeps the `── Cleared` sentinel so isClearDivider still matches', () => {
    expect(isClearDivider(formatClearKeepPlanDivider(at, 'tidy-sailing-wren'))).toBe(true)
    expect(isClearDivider(formatClearKeepPlanDivider(at, ''))).toBe(true)
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

describe('formatDispatchLostDivider', () => {
  // Every client renders this divider from the server's transcript row, so
  // the wording here is the wording on every device.
  it('names the agent and the restart', () => {
    const at = new Date(2026, 8, 10, 13, 0)
    const text = formatDispatchLostDivider(at, 'agent-2')
    expect(text).toContain('agent-2 was lost when the engine restarted at')
    expect(isDispatchLostDivider(text)).toBe(true)
  })

  it('falls back to a generic noun when the engine could not attribute the orphan', () => {
    const text = formatDispatchLostDivider(new Date(2026, 8, 10, 13, 0), '')
    expect(text).toContain('agent was lost when the engine restarted at')
    expect(isDispatchLostDivider(text)).toBe(true)
  })

  it('does not match an unrelated divider', () => {
    expect(isDispatchLostDivider(formatSteerAppliedDivider(new Date(), 12))).toBe(false)
  })
})
