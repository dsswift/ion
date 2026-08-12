// @vitest-environment jsdom
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../theme', () => ({
  useColors: () => ({ textTertiary: '#888' }),
}))

import { formatRunDuration, RunDurationFooter, runDurationLabel } from './RunDurationFooter'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('RunDurationFooter', () => {
  it('formats sub-second through hour-long runs compactly', () => {
    expect(formatRunDuration(0)).toBe('<1s')
    expect(formatRunDuration(999)).toBe('<1s')
    expect(formatRunDuration(1_000)).toBe('1s')
    expect(formatRunDuration(59_999)).toBe('59s')
    expect(formatRunDuration(60_000)).toBe('1m 0s')
    expect(formatRunDuration(127_000)).toBe('2m 7s')
    expect(formatRunDuration(3_661_000)).toBe('1h 1m')
  })

  it('uses completion reason in its label', () => {
    expect(runDurationLabel(12_000)).toBe('Completed in 12s')
    expect(runDurationLabel(12_000, 'aborted')).toBe('Stopped after 12s')
    expect(runDurationLabel(12_000, 'max_turns')).toBe('Ended after 12s')
  })

  it('renders compact left-aligned metadata without separator rails', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(<RunDurationFooter durationMs={1_000} reason="normal" />))
    const row = container.querySelector('[aria-label="Completed in 1s"]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toBe('Completed in 1s')
    expect(row?.querySelectorAll('div')).toHaveLength(0)
    act(() => root.unmount())
  })
})
