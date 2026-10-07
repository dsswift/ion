import { describe, expect, it } from 'vitest'
import { INBOX_ROW_OPACITY, inboxRowEmphasis, type InboxRowStatus } from './inbox-row-emphasis'

const row = (status: InboxRowStatus | null, extra: Partial<Parameters<typeof inboxRowEmphasis>[0]> = {}) =>
  inboxRowEmphasis({ status, focused: false, unread: false, woke: false, held: false, ...extra })

describe('inboxRowEmphasis', () => {
  it('recedes a busy conversation furthest, below a read idle one', () => {
    for (const status of ['Working', 'Monitoring', 'Connecting'] as const) expect(row(status)).toBe('working')
    expect(row(null)).toBe('quiet')
    expect(INBOX_ROW_OPACITY.working).toBeLessThan(INBOX_ROW_OPACITY.quiet)
    expect(INBOX_ROW_OPACITY.quiet).toBeLessThan(INBOX_ROW_OPACITY.full)
  })

  it('recedes a busy conversation even when it has unread output', () => {
    expect(row('Working', { unread: true })).toBe('working')
  })

  it('keeps the open, selected, or woken conversation at full strength', () => {
    expect(row('Working', { focused: true })).toBe('full')
    expect(row('Working', { woke: true })).toBe('full')
  })

  it('keeps rows that ask something of the person at full strength', () => {
    for (const status of ['Approval', 'Plan Ready', 'Input', 'Failed', 'Done', 'Limited'] as const) expect(row(status)).toBe('full')
    expect(row(null, { unread: true })).toBe('full')
  })

  it('lets a limited conversation with a held prompt recede', () => {
    expect(row('Limited', { held: true })).toBe('quiet')
  })
})
