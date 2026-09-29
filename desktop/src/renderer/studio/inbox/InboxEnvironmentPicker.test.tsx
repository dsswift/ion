// @vitest-environment jsdom
/**
 * The Inbox's environment switcher — the control that was missing.
 *
 * The filter itself already existed and was persisted, but only the
 * Transfer dialog ever wrote it, so a narrowed Inbox could not be widened
 * from anywhere in the UI. These pin the two things that made it a one-way
 * door: that "All environments" is reachable, and that the local entry
 * writes the `local` sentinel rather than the local environment's id.
 */
import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxEnvironmentPicker } from './InboxControls'
import type { EnvironmentViewFilter } from '@ion/shared/types-environments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../hooks/useAnchoredPopover', () => ({ useAnchoredPopover: () => ({ ref: () => {}, left: 0, top: 0, ready: true }) }))
vi.mock('../connection/environment-availability', () => ({
  useEnvironmentAvailabilityMap: () => new Map([['grover', { environmentId: 'grover', label: 'grover', availability: 'offline', since: Date.now() - 60_000 }]]),
}))

let picked: EnvironmentViewFilter | null = null

function Harness({ initial }: { initial: EnvironmentViewFilter }): React.JSX.Element {
  const [selected, setSelected] = useState<EnvironmentViewFilter>(initial)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return <InboxEnvironmentPicker
    anchor={{ x: 0, y: 0 }}
    environments={[
      { id: 'local', label: 'This Mac', count: 30 },
      { id: 'grover', label: 'grover', count: 67 },
    ]}
    selected={selected}
    onSelect={(next) => { picked = next; setSelected(next) }}
    triggerRef={triggerRef}
    onClose={() => {}}
  />
}

let host: HTMLDivElement
let root: Root

function render(initial: EnvironmentViewFilter): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(<Harness initial={initial} />) })
}

function option(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label))
}

beforeEach(() => { picked = null; document.body.innerHTML = '' })

describe('InboxEnvironmentPicker', () => {
  it('offers a way back to every environment, with each one\'s conversation count', () => {
    render('local')
    const all = option('All environments')
    expect(all).toBeDefined()
    expect(all!.textContent).toContain('97')

    act(() => { all!.click() })
    expect(picked).toBe('all')
  })

  /**
   * The local entry must write the `local` sentinel: `tabMatchesEnvironmentFilter`
   * compares a filter of any other value against the tab's own environmentId,
   * and a local tab carries none.
   */
  it('writes the local sentinel for this machine and the id for a remote host', () => {
    render('all')
    act(() => { option('This Mac')!.click() })
    expect(picked).toBe('local')

    act(() => { option('grover')!.click() })
    expect(picked).toBe('grover')
  })

  it('says when an environment is offline, so an empty list is explained rather than mysterious', () => {
    render('all')
    expect(option('grover')!.textContent).toContain('offline')
  })
})
