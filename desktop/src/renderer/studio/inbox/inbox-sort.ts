/** The inbox's active-list sort orders and the one it starts on. */
export type InboxSortOrder = 'created' | 'activity' | 'title'

/** The order a new inbox uses, and the one its sort button shows as resting. */
export const DEFAULT_INBOX_SORT_ORDER: InboxSortOrder = 'created'

/** A stored sort order, or the default when it is missing or unknown. */
export function parseInboxSortOrder(value: string | null): InboxSortOrder {
  return value === 'created' || value === 'title' || value === 'activity' ? value : DEFAULT_INBOX_SORT_ORDER
}
