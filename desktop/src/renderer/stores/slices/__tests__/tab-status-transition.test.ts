import { describe, it, expect } from 'vitest'
import { setTabStatus } from '../tab-status-transition'
import type { TabState } from '../../../../shared/types'

/** Minimal TabState factory for unit tests. Only fields setTabStatus needs. */
function makeTab(id: string, status: TabState['status'] = 'idle'): TabState {
  return { id, status } as unknown as TabState
}

describe('setTabStatus', () => {
  it('transitions status when tab found and no guard', () => {
    const tabs = [makeTab('a', 'idle'), makeTab('b', 'idle')]
    const result = setTabStatus(tabs, 'a', 'connecting')
    expect(result[0].status).toBe('connecting')
    expect(result[1].status).toBe('idle')
    expect(result).not.toBe(tabs) // new array
  })

  it('returns same reference when tab not found', () => {
    const tabs = [makeTab('a', 'idle')]
    const result = setTabStatus(tabs, 'missing', 'connecting')
    expect(result).toBe(tabs)
  })

  it('returns same reference when already at target status (no-op, no spurious re-render)', () => {
    const tabs = [makeTab('a', 'idle')]
    const result = setTabStatus(tabs, 'a', 'idle')
    expect(result).toBe(tabs)
  })

  it('guard accepts — transition fires', () => {
    const tabs = [makeTab('a', 'connecting')]
    const result = setTabStatus(tabs, 'a', 'idle', (t) => t.status === 'connecting')
    expect(result[0].status).toBe('idle')
    expect(result).not.toBe(tabs)
  })

  it('guard rejects — no mutation, same reference', () => {
    const tabs = [makeTab('a', 'running')]
    const result = setTabStatus(tabs, 'a', 'idle', (t) => t.status === 'connecting')
    expect(result[0].status).toBe('running')
    expect(result).toBe(tabs)
  })

  it('does not mutate other tabs', () => {
    const tabs = [makeTab('a', 'idle'), makeTab('b', 'idle'), makeTab('c', 'idle')]
    const result = setTabStatus(tabs, 'b', 'running')
    expect(result[0]).toBe(tabs[0]) // same reference — untouched
    expect(result[2]).toBe(tabs[2]) // same reference — untouched
    expect(result[1].status).toBe('running')
  })

  it('does not mutate the original tab object', () => {
    const tab = makeTab('a', 'idle')
    const tabs = [tab]
    setTabStatus(tabs, 'a', 'running')
    expect(tab.status).toBe('idle') // original unchanged
  })

  it('terminal guard: running tab must not transition to idle', () => {
    // Simulates the clearConnectingStatus guard: only 'connecting' → 'idle'
    const tabs = [makeTab('a', 'running')]
    const result = setTabStatus(tabs, 'a', 'idle', (t) => t.status === 'connecting')
    expect(result).toBe(tabs) // guard rejected
    expect(result[0].status).toBe('running')
  })

  it('does not hold onto the original array elements after transition', () => {
    const tabs = [makeTab('a', 'connecting')]
    const result = setTabStatus(tabs, 'a', 'idle')
    // The transitioned element is a NEW object, not the original
    expect(result[0]).not.toBe(tabs[0])
    expect(result[0].id).toBe('a')
    expect(result[0].status).toBe('idle')
  })
})
