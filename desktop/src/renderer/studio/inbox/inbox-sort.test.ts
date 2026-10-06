import { describe, expect, it } from 'vitest'
import { DEFAULT_INBOX_SORT_ORDER, parseInboxSortOrder } from './inbox-sort'

describe('inbox sort order', () => {
  it('defaults to newest created, the order the sort button shows as resting', () => {
    expect(DEFAULT_INBOX_SORT_ORDER).toBe('created')
    expect(parseInboxSortOrder(null)).toBe('created')
    expect(parseInboxSortOrder('bogus')).toBe('created')
  })

  it('keeps a stored choice', () => {
    for (const order of ['created', 'activity', 'title'] as const) expect(parseInboxSortOrder(order)).toBe(order)
  })
})
