// @vitest-environment jsdom
//
// Directory-menu move submenu must dismiss locally when pointer returns to a
// main-menu row. Its portalled sibling must not unmount parent before that
// row's click runs.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

let portalTarget: HTMLDivElement
const moveTabToGroup = vi.fn()

vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) =>
      <div ref={ref} {...props}>{children}</div>),
  },
}))

vi.mock('@phosphor-icons/react', () => ({
  FolderPlus: () => null, GitFork: () => null, CheckCircle: () => null,
  CaretDown: () => null, Rows: () => null, PushPin: () => null,
  Plus: () => null, ArrowRight: () => null,
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => portalTarget,
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (state: { tabGroupMode: 'manual'; tabGroups: Array<{ id: string; label: string }> }) => unknown) =>
      selector({ tabGroupMode: 'manual', tabGroups: [{ id: 'group-2', label: 'Elsewhere' }] }),
    { getState: () => ({ uiZoom: 1 }) },
  ),
  getEffectiveTabGroups: (groups: Array<{ id: string; label: string }>) => groups,
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { tabs: never[]; moveTabToGroup: typeof moveTabToGroup; moveTabToGroupAndPin: typeof moveTabToGroup }) => unknown) =>
      selector({ tabs: [], moveTabToGroup, moveTabToGroupAndPin: moveTabToGroup }),
    { getState: () => ({}) },
  ),
}))

import { DirContextMenu } from '../TabStripDirContextMenu'

function findButton(text: string): HTMLButtonElement {
  const button = [...portalTarget.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`No button labelled ${text}`)
  return button
}

describe('DirContextMenu move submenu', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    portalTarget = document.createElement('div')
    document.body.appendChild(portalTarget)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    moveTabToGroup.mockClear()
  })

  afterEach(() => {
    act(() => { root.unmount() })
    document.body.replaceChildren()
  })

  it('closes move submenu before running another parent-menu action', () => {
    const onCreateTab = vi.fn()
    act(() => {
      root.render(
        <DirContextMenu
          anchor={{ x: 10, y: 10 }}
          dirName="project"
          tabId="tab-1"
          tabGroupId="group-1"
          onCreateTab={onCreateTab}
          onClose={() => {}}
        />,
      )
    })

    const move = findButton('Move to group')
    act(() => { move.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(portalTarget.textContent).toContain('Elsewhere')

    const create = findButton('New tab in project')
    act(() => { create.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(portalTarget.textContent).not.toContain('Elsewhere')

    act(() => {
      create.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCreateTab).toHaveBeenCalledOnce()
  })
})
