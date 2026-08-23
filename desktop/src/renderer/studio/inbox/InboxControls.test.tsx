// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxControlButton, InboxProjectScopePicker, InboxSortPicker } from './InboxControls'
import { loadProjectSelection, saveProjectSelection, toggleProjectSelection } from './project-selection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../hooks/useAnchoredPopover', () => ({
  useAnchoredPopover: () => ({ ref: () => {}, left: 0, top: 0, ready: true }),
}))

type PickerKind = 'project' | 'sort' | null

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState<PickerKind>(null)
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<'created' | 'activity' | 'title'>('activity')
  const projectRef = useRef<HTMLButtonElement>(null)
  const sortRef = useRef<HTMLButtonElement>(null)
  return <div>
    <InboxControlButton buttonRef={projectRef} onClick={() => setOpen((current) => current === 'project' ? null : 'project')}>
      Projects
    </InboxControlButton>
    <InboxControlButton buttonRef={sortRef} onClick={() => setOpen((current) => current === 'sort' ? null : 'sort')}>
      Recent activity
    </InboxControlButton>
    {open === 'project' && <InboxProjectScopePicker
      anchor={{ x: 0, y: 0 }}
      projects={[
        { key: '/one', name: 'One', count: 1 },
        { key: '/two', name: 'Two', count: 2 },
      ]}
      selected={projects}
      onSelect={setProjects}
      triggerRef={projectRef}
      onClose={() => setOpen(null)}
    />}
    {open === 'sort' && <InboxSortPicker
      anchor={{ x: 0, y: 0 }}
      selected={sort}
      onSelect={setSort}
      triggerRef={sortRef}
      onClose={() => setOpen(null)}
    />}
  </div>
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
}

describe('Inbox project selection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(<Harness />) })
  })

  it('adds and removes projects without closing the picker', async () => {
    await act(async () => { button('Projects').click() })
    await act(async () => { button('One').click() })

    expect(button('One').getAttribute('aria-pressed')).toBe('true')
    expect(button('All projects').getAttribute('aria-pressed')).toBe('false')
    expect(button('Two')).not.toBeNull()

    await act(async () => { button('Two').click() })
    expect(button('One').getAttribute('aria-pressed')).toBe('true')
    expect(button('Two').getAttribute('aria-pressed')).toBe('true')

    await act(async () => { button('One').click() })
    expect(button('One').getAttribute('aria-pressed')).toBe('false')
    expect(button('Two').getAttribute('aria-pressed')).toBe('true')
  })

  it('clears individual projects when all projects is selected', async () => {
    await act(async () => { button('Projects').click() })
    await act(async () => { button('One').click(); button('Two').click() })
    await act(async () => { button('All projects').click() })

    expect(button('All projects').getAttribute('aria-pressed')).toBe('true')
    expect(button('One').getAttribute('aria-pressed')).toBe('false')
    expect(button('Two').getAttribute('aria-pressed')).toBe('false')
  })

  it('toggles both picker buttons closed', async () => {
    await act(async () => { button('Projects').click() })
    expect(button('All projects')).not.toBeNull()
    await act(async () => { button('Projects').click() })
    expect(document.body.textContent).not.toContain('All projects')

    await act(async () => { button('Recent activity').click() })
    expect(button('Newest created')).not.toBeNull()
    await act(async () => { button('Recent activity').click() })
    expect(document.body.textContent).not.toContain('Newest created')
  })

  it('loads legacy filters and saves multi-project filters', () => {
    expect([...loadProjectSelection('/legacy/project')]).toEqual(['/legacy/project'])
    expect([...loadProjectSelection('["/one","/two"]')]).toEqual(['/one', '/two'])
    expect(saveProjectSelection(new Set())).toBeNull()
    expect(saveProjectSelection(new Set(['/one', '/two']))).toBe('["/one","/two"]')
    expect([...toggleProjectSelection(new Set(['/one']), '/two')]).toEqual(['/one', '/two'])
  })
})
