import { describe, expect, it } from 'vitest'
import type { TabState } from '../../../shared/types'
import { collapsedInboxRows } from './inbox-collapse'

function tab(id: string, pinnedAt: number | null = null, pinOrderKey: string | null = null): TabState {
  return { id, pinnedAt, pinOrderKey, createdAt: 0 } as TabState
}

describe('collapsed inbox groups', () => {
  it('keeps only pinned rows in a collapsed project or location group', () => {
    const tabs = [tab('pinned-last', 1, 'z'), tab('active'), tab('pinned-first', 2, 'a')]
    expect(collapsedInboxRows(tabs).map(({ id }) => id))
      .toEqual(['pinned-first', 'pinned-last'])
  })

  it('does not duplicate the active conversation when it is pinned', () => {
    expect(collapsedInboxRows([tab('pinned-active', 1), tab('other')]).map(({ id }) => id))
      .toEqual(['pinned-active'])
  })
})
