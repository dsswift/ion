import { describe, expect, it } from 'vitest'
import { planExportFileName } from '../plan-export'

describe('planExportFileName', () => {
  it('keeps the source basename and adds the local export timestamp', () => {
    const exportedAt = new Date(2027, 2, 5, 9, 7)

    expect(planExportFileName('/plans/release.plan.md', exportedAt)).toBe('release.plan-20270305-0907.md')
  })

  it('normalizes a non-markdown source to a markdown export', () => {
    const exportedAt = new Date(2027, 10, 15, 23, 4)

    expect(planExportFileName('C:\\plans\\migration-plan.txt', exportedAt)).toBe('migration-plan.txt-20271115-2304.md')
  })
})
