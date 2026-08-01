// @vitest-environment jsdom
//
// Convert-to-worktree must follow live repository state, not whether this
// conversation wrote a file at some point. A clean checkout remains convertible
// after prior Write/Edit tool calls; a dirty checkout must remain protected.

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

const mocks = vi.hoisted(() => ({
  convertToWorktree: vi.fn().mockResolvedValue(undefined),
  rWarn: vi.fn(),
}))
let portalTarget: HTMLDivElement
let gitChanges: ReturnType<typeof vi.fn>

vi.mock('@phosphor-icons/react', () => ({
  Plus: () => null, GitFork: () => null, FolderOpen: () => null, GitBranch: () => null,
  CheckCircle: () => null, CaretDown: () => null, Rows: () => null, PencilSimple: () => null,
  ArrowRight: () => null, ArrowsInSimple: () => null, PushPin: () => null, PushPinSlash: () => null,
  Diamond: () => null, Square: () => null, StarFour: () => null, Triangle: () => null,
  Heart: () => null, Hexagon: () => null, Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) =>
      <div ref={ref} {...props}>{children}</div>),
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => portalTarget,
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (state: { tabGroupMode: string; tabGroups: never[] }) => unknown) => selector({ tabGroupMode: 'auto', tabGroups: [] }),
    { getState: () => ({ tabGroups: [], worktreeBranchDefaults: {}, uiZoom: 1 }) },
  ),
  getEffectiveTabGroups: () => [],
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { moveTabToGroup: () => void; toggleTabGroupPin: () => void }) => unknown) => selector({
      moveTabToGroup: () => {},
      toggleTabGroupPin: () => {},
    }),
    { getState: () => ({ convertToWorktree: mocks.convertToWorktree }) },
  ),
}))

vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rError: vi.fn(),
  rWarn: mocks.rWarn,
}))

import { TabContextMenu } from '../TabStripTabContextMenu'

const tab = {
  id: 'tab-1',
  workingDirectory: '/repo',
  worktree: null,
} as TabState

function renderMenu() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TabContextMenu
        anchor={{ x: 10, y: 10 }}
        tab={tab}
        onNewTabInDir={() => {}}
        onFinishWork={() => {}}
        onClose={() => {}}
      />,
    )
  })
  return { container, root }
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

function convertButton() {
  return [...portalTarget.querySelectorAll('button')]
    .find((button) => button.textContent?.startsWith('Convert to worktree'))
}

beforeEach(() => {
  portalTarget = document.createElement('div')
  document.body.appendChild(portalTarget)
  mocks.convertToWorktree.mockClear()
  mocks.rWarn.mockClear()
  gitChanges = vi.fn()
  window.ion = {
    gitIsRepo: vi.fn().mockResolvedValue({ isRepo: true }),
    gitChanges,
  } as unknown as typeof window.ion
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('TabContextMenu convert to worktree', () => {
  it('enables conversion after prior file activity when repository is clean', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    const { container, root } = renderMenu()

    await settle()

    const button = convertButton()
    expect(button).toBeDefined()
    expect(button?.textContent).toBe('Convert to worktree')
    expect(button?.disabled).toBe(false)
    act(() => { button!.click() })
    expect(mocks.convertToWorktree).toHaveBeenCalledWith('tab-1')

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion and names uncommitted changes', async () => {
    gitChanges.mockResolvedValue({ files: [{ path: 'changed.ts' }] })
    const { container, root } = renderMenu()

    await settle()

    const button = convertButton()
    expect(button?.textContent).toBe('Convert to worktree (uncommitted changes)')
    expect(button?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion while repository state is loading', async () => {
    let resolveRepo!: (result: { isRepo: boolean }) => void
    window.ion.gitIsRepo = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRepo = resolve }))
    gitChanges.mockReturnValue(new Promise(() => {}))
    const { container, root } = renderMenu()

    await settle()
    resolveRepo({ isRepo: true })
    await settle()

    const button = convertButton()
    expect(button?.textContent).toBe('Convert to worktree (checking...)')
    expect(button?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('allows conversion when dirtiness probe fails', async () => {
    gitChanges.mockRejectedValue(new Error('git unavailable'))
    const { container, root } = renderMenu()

    await settle()

    const button = convertButton()
    expect(button?.textContent).toBe('Convert to worktree')
    expect(button?.disabled).toBe(false)
    expect(mocks.rWarn).toHaveBeenCalledWith(
      'tab-context-menu',
      'convert-to-worktree dirtiness probe failed; allowing conversion',
      expect.objectContaining({ tab_id: 'tab-1' }),
    )

    act(() => { root.unmount() })
    container.remove()
  })
})
