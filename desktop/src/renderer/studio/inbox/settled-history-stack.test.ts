import { describe, expect, it } from 'vitest'
import type { TabState } from '../../../shared/types'

function order(tabs: readonly TabState[]): string[] {
  return [...tabs].sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0) || left.id.localeCompare(right.id)).map((tab) => tab.id)
}

describe('settled history stack', () => {
  it('orders records newest first with a stable ID fallback', () => {
    const tabs = [{ id: 'b', settledAt: 10 }, { id: 'a', settledAt: 10 }, { id: 'old', settledAt: 1 }] as TabState[]
    expect(order(tabs)).toEqual(['a', 'b', 'old'])
  })
})
