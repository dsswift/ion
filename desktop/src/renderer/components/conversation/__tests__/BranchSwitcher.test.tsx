// @vitest-environment jsdom
/**
 * BranchSwitcher: hidden for a single-path conversation, lists the paths a
 * rewind left behind, and switches through the engine when one is chosen.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ConversationBranches } from '@ion/shared/conversation-branches'

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
const shell = vi.hoisted(() => ({
  engineListBranches: vi.fn(),
  engineSwitchBranch: vi.fn(async () => undefined),
}))
vi.mock('../../../host/host-instance', () => ({ host: { shell } }))

import { BranchSwitcher } from '../BranchSwitcher'

const twoBranches: ConversationBranches = {
  activeLeafId: 'leaf-b',
  branchPoints: [{ entryId: 'fork', timestamp: 1, childIds: ['a1', 'b1'] }],
  branches: [
    { leafId: 'leaf-a', timestamp: Date.now() - 60_000, preview: 'reply A', messageCount: 4, forkPointId: 'fork', active: false },
    { leafId: 'leaf-b', timestamp: Date.now(), preview: 'reply B', messageCount: 4, forkPointId: 'fork', active: true },
  ],
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  shell.engineListBranches.mockReset()
  shell.engineSwitchBranch.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Renders and lets the branch read settle. */
async function mount(ui: React.ReactElement): Promise<void> {
  await act(async () => { root.render(ui) })
}

/** The innermost element whose whole text is `text`. */
function byText(text: string): HTMLElement | null {
  const matches = Array.from(container.querySelectorAll<HTMLElement>('span, div')).filter((el) => el.textContent === text)
  return matches.at(-1) ?? null
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('nothing to click')
  await act(async () => { (el as HTMLElement).click() })
}

describe('BranchSwitcher', () => {
  it('shows nothing when the conversation has one path', async () => {
    shell.engineListBranches.mockResolvedValue({ activeLeafId: 'x', branches: [{ leafId: 'x', timestamp: 1, preview: 'p', messageCount: 2, active: true }], branchPoints: [] })
    await mount(<BranchSwitcher tabId="tab-1" messageCount={2} isRunning={false} />)
    expect(shell.engineListBranches).toHaveBeenCalledWith('tab-1')
    expect(container.querySelector('[data-testid="branch-switcher"]')).toBeNull()
  })

  it('lists the branches and switches to the one chosen', async () => {
    shell.engineListBranches.mockResolvedValue(twoBranches)
    await mount(<BranchSwitcher tabId="tab-1" messageCount={4} isRunning={false} />)
    expect(byText('2 branches')).not.toBeNull()
    await click(container.querySelector('button[aria-expanded]'))
    expect(byText('reply B')?.closest('button')?.disabled).toBe(true)
    await click(byText('reply A'))
    expect(shell.engineSwitchBranch).toHaveBeenCalledWith('tab-1', 'leaf-a')
  })

  it('does not ask the engine while a run is going', async () => {
    await mount(<BranchSwitcher tabId="tab-1" messageCount={4} isRunning />)
    expect(shell.engineListBranches).not.toHaveBeenCalled()
  })

  it('shows why a switch was refused', async () => {
    shell.engineListBranches.mockResolvedValue(twoBranches)
    shell.engineSwitchBranch.mockRejectedValueOnce(new Error('switch branch: a run is active'))
    await mount(<BranchSwitcher tabId="tab-1" messageCount={4} isRunning={false} />)
    expect(byText('2 branches')).not.toBeNull()
    await click(container.querySelector('button[aria-expanded]'))
    await click(byText('reply A'))
    expect(byText('switch branch: a run is active')).not.toBeNull()
  })
})
