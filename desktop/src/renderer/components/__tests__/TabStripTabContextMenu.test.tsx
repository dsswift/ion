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
let tabGroupMode: 'auto' | 'manual'
let tabGroups: Array<{ id: string; label: string }>
let moveTabToGroup: ReturnType<typeof vi.fn>
let moveTabToGroupAndPin: ReturnType<typeof vi.fn>

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
    (selector: (state: { tabGroupMode: 'auto' | 'manual'; tabGroups: Array<{ id: string; label: string }> }) => unknown) => selector({ tabGroupMode, tabGroups }),
    { getState: () => ({ tabGroups, worktreeBranchDefaults: {}, uiZoom: 1 }) },
  ),
  getEffectiveTabGroups: (groups: Array<{ id: string; label: string }>) => groups,
}))

// The convert gate subscribes to `conversationPanes` to answer "is this tab
// busy?", so the mocked store has to serve it through the selector like the
// real one does. `panes` is reassigned per test.
let panes: Map<string, unknown>

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: {
      moveTabToGroup: () => void
      moveTabToGroupAndPin: () => void
      toggleTabGroupPin: () => void
      conversationPanes: Map<string, unknown>
    }) => unknown) => selector({
      moveTabToGroup: moveTabToGroup as () => void,
      moveTabToGroupAndPin: moveTabToGroupAndPin as () => void,
      toggleTabGroupPin: () => {},
      conversationPanes: panes,
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

const baseTab = {
  id: 'tab-1',
  workingDirectory: '/repo',
  worktree: null,
  status: 'idle',
  bashExecuting: false,
} as unknown as TabState

/** A pane whose single instance carries the given status fields / agents. */
function paneWith(inst: Record<string, unknown>) {
  return new Map<string, unknown>([
    ['tab-1', { instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [], ...inst }] }],
  ])
}

function renderMenu(
  over: Partial<TabState> = {},
  options: { onRename?: () => void; onClose?: () => void; groupTabs?: TabState[] } = {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TabContextMenu
        anchor={{ x: 10, y: 10 }}
        tab={{ ...baseTab, ...over }}
        onRename={options.onRename}
        onNewTabInDir={() => {}}
        onFinishWork={() => {}}
        onClose={options.onClose ?? (() => {})}
        groupTabs={options.groupTabs}
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
  panes = new Map()
  tabGroupMode = 'auto'
  tabGroups = []
  moveTabToGroup = vi.fn()
  moveTabToGroupAndPin = vi.fn()
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


  it('closes move submenu when pointer enters an ordinary parent item, then runs that item', async () => {
    tabGroupMode = 'manual'
    tabGroups = [{ id: 'group-2', label: 'Elsewhere' }]
    gitChanges.mockResolvedValue({ files: [] })
    const onRename = vi.fn()
    const { container, root } = renderMenu({ groupId: 'group-1' }, { onRename })

    await settle()

    const move = [...portalTarget.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Move to group')!
    act(() => { move.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(portalTarget.textContent).toContain('Elsewhere')

    const rename = [...portalTarget.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Rename')!
    act(() => { rename.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(portalTarget.textContent).not.toContain('Elsewhere')

    act(() => {
      rename.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rename.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRename).toHaveBeenCalledOnce()

    act(() => { root.unmount() })
    container.remove()
  })

  it.each([
    ['Move to group', undefined],
    ['Move to group and pin', undefined],
    ['Move all to group', [baseTab, { ...baseTab, id: 'tab-2' }]],
  ] as Array<[string, TabState[] | undefined]>)('keeps %s submenu open while pointer crosses parent-menu padding', async (label, groupTabs) => {
    tabGroupMode = 'manual'
    tabGroups = [{ id: 'group-2', label: 'Elsewhere' }]
    gitChanges.mockResolvedValue({ files: [] })
    const { container, root } = renderMenu(
      { groupId: 'group-1' },
      { groupTabs },
    )

    await settle()

    const move = [...portalTarget.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === label)!
    act(() => { move.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

    const parentMenu = [...portalTarget.querySelectorAll('[data-ion-ui]')]
      .find((menu) => menu.contains(move))!
    act(() => { parentMenu.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

    const target = [...portalTarget.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Elsewhere')!
    expect(target).toBeDefined()
    act(() => { target.click() })

    if (label === 'Move all to group') {
      expect(portalTarget.textContent).toContain('Move all tabs?')
    } else if (label === 'Move to group and pin') {
      expect(moveTabToGroupAndPin).toHaveBeenCalledWith('tab-1', 'group-2')
    } else {
      expect(moveTabToGroup).toHaveBeenCalledWith('tab-1', 'group-2')
    }

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

/**
 * Converting relocates the tab, and relocation restarts the engine session
 * (setTabWorkingDirectory -> relocateTabSession -> restartTabEntry ->
 * stopSession). Converting a busy tab therefore aborts its in-flight run, so
 * the row has to refuse while work is outstanding.
 *
 * This arm is independent of the dirtiness arm above and neither subsumes the
 * other: a running agent that has not yet written a file leaves the checkout
 * clean, so the dirtiness probe alone reports the row as available while
 * conversion is still destructive. Every case below therefore uses a CLEAN
 * repository — that is precisely the combination the dirtiness gate misses.
 */
describe('TabContextMenu convert to worktree — busy tab', () => {
  it('blocks conversion while the orchestrator is running', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    const { container, root } = renderMenu({ status: 'running' })

    await settle()

    const button = convertButton()
    expect(button?.textContent).toBe('Convert to worktree (tab is busy)')
    expect(button?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion while the tab is connecting', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    const { container, root } = renderMenu({ status: 'connecting' })

    await settle()

    expect(convertButton()?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion while a user bash command is executing', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    const { container, root } = renderMenu({ bashExecuting: true })

    await settle()

    expect(convertButton()?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion when an instance runs though the tab reads idle', async () => {
    // The case a tab.status-only guard misses.
    gitChanges.mockResolvedValue({ files: [] })
    panes = paneWith({ statusFields: { state: 'running' } })
    const { container, root } = renderMenu()

    await settle()

    const button = convertButton()
    expect(button?.textContent).toBe('Convert to worktree (tab is busy)')
    expect(button?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion while a dispatched background agent is running', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    panes = paneWith({ agentStates: [{ status: 'running' }] })
    const { container, root } = renderMenu()

    await settle()

    expect(convertButton()?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('blocks conversion while a background shell is outstanding', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    panes = paneWith({ statusFields: { state: 'idle', backgroundShells: 1 } })
    const { container, root } = renderMenu()

    await settle()

    expect(convertButton()?.disabled).toBe(true)

    act(() => { root.unmount() })
    container.remove()
  })

  it('names busy rather than dirt when the tab is both', async () => {
    // Busy outranks: it is the more urgent reason and the one the operator can
    // act on immediately (interrupt, or wait for idle).
    gitChanges.mockResolvedValue({ files: [{ path: 'changed.ts' }] })
    const { container, root } = renderMenu({ status: 'running' })

    await settle()

    expect(convertButton()?.textContent).toBe('Convert to worktree (tab is busy)')

    act(() => { root.unmount() })
    container.remove()
  })

  it('does not dispatch the action when the busy row is clicked', async () => {
    gitChanges.mockResolvedValue({ files: [] })
    const { container, root } = renderMenu({ status: 'running' })

    await settle()

    act(() => { convertButton()!.click() })
    expect(mocks.convertToWorktree).not.toHaveBeenCalled()

    act(() => { root.unmount() })
    container.remove()
  })
})
