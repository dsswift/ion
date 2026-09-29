// @vitest-environment jsdom
/**
 * TransferDialog — what moves, and where it lands.
 *
 * A worktree conversation can leave its worktree on its own (the default)
 * or take the whole worktree with it. On its own, it lands in the chosen
 * project's checkout, one of its worktrees, or a new worktree cut from a
 * branch there. The machine it is already on is a target too, and then the
 * move is a relocation, never an export — and never to where it already is.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE = '/Users/u/.ion/worktrees/ion-1'
const start = vi.fn()
const moveHere = vi.fn()
const transferState = { status: 'idle', progress: null, failure: null, targetEnvironmentId: null, targetTabId: null, movedCount: 0, totalCount: 0, workingDirectory: null, start, moveHere, retry: vi.fn(), reset: vi.fn(), cancel: vi.fn() }

const actionMock = vi.fn(async (_env: string, name: string, _args?: unknown[]): Promise<unknown> => {
  if (name === 'transfer.describe') return {
    status: 'idle',
    worktree: { repoRemote: 'github.com/o/ion', branch: 'wt/ion-1', sourceBranch: 'josh', repoPath: '/src/ion', originUrl: 'git@github.com:o/ion.git', dirty: true, suggestedParentDir: '~/src', siblings: [{ tabId: 'tab-2', title: 'Second' }] },
    project: { workingDirectory: WORKTREE, repoRemote: 'github.com/o/ion', originUrl: 'git@github.com:o/ion.git', suggestedParentDir: '~/src' },
  }
  if (name === 'transfer.preflight') return { projectDir: '/src/ion', projectDirs: ['/src/ion'], allProjectDirs: ['/notes', '/src/ion'], sourceDirectoryExists: true, hasSourceBranch: true, knownTips: [], worktreeCopy: null }
  if (name === 'transfer.landings') return { worktrees: [{ worktreePath: WORKTREE, branchName: 'wt/ion-1', title: 'Fix the bug' }], branches: ['josh', 'main'], currentBranch: 'main' }
  throw new Error(`unexpected ${name}`)
})

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../../connection/tab-environment', () => ({ useTabEnvironmentId: () => 'env-source' }))
vi.mock('../../connection/catalog', () => ({ readCatalog: async () => [{ id: 'env-source', label: 'Laptop' }, { id: 'env-target', label: 'Studio' }] }))
vi.mock('../../connection/view-filter', () => ({ useEnvironmentViewFilter: () => ['all', vi.fn()] }))
vi.mock('../../../host/host-instance', () => ({
  host: {
    connections: async () => [{ environmentId: 'env-source', phase: { phase: 'connected' } }, { environmentId: 'env-target', phase: { phase: 'connected' } }],
    onFrame: () => () => undefined,
  },
  action: (env: string, name: string, args?: unknown[]) => actionMock(env, name, args),
}))
vi.mock('../useTransfer', () => ({ useTransfer: () => transferState }))
vi.mock('../TransferPreflightPanel', () => ({ TransferPreflightPanel: () => <div /> }))
vi.mock('../../connection/environment-projects', () => ({ useProjectsByEnvironment: () => ({}) }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: { tabs: unknown[] }) => unknown) => selector({ tabs: [{ id: 'tab-1', workingDirectory: WORKTREE }] }),
}))

import { TransferDialog } from '../TransferDialog'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await flush() })
}

function field(label: string): HTMLButtonElement | null {
  return host.querySelector(`button[aria-label="${label}"]`)
}

async function pick(label: string, optionText: string): Promise<void> {
  await act(async () => { field(label)!.click() })
  const option = Array.from(host.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent?.startsWith(optionText))
  if (!option) throw new Error(`no option ${optionText} in ${label}`)
  await act(async () => { (option as HTMLButtonElement).click() })
  await settle()
}

function primaryButton(): HTMLButtonElement {
  const buttons = Array.from(host.querySelectorAll('button')).filter((b) => !b.getAttribute('aria-label'))
  return buttons.find((b) => ['Transfer', 'Move'].includes(b.textContent ?? '') || b.textContent?.startsWith('Move worktree'))!
}

beforeEach(async () => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<TransferDialog tabId="tab-1" onClose={vi.fn()} />) })
  await settle()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('TransferDialog: what moves and where it lands', () => {
  it('moves just this conversation by default, to another machine, into the matching checkout', async () => {
    expect(field('What moves')!.textContent).toContain('Just this conversation')
    expect(field('Target environment')!.textContent).toContain('Studio')
    expect(field('Lands in')!.textContent).toContain('/src/ion')
    expect(field('Worktree')!.textContent).toContain('Source checkout')
    // The worktree is dirty, and that does not matter: it stays behind.
    expect(primaryButton().disabled).toBe(false)

    await act(async () => { primaryButton().click() })
    expect(start).toHaveBeenCalledWith('env-source', 'tab-1', 'env-target', {}, [], { kind: 'checkout', dir: '/src/ion' })
  })

  it('cuts a new worktree from the conversation\'s own base branch when asked', async () => {
    await pick('Worktree', 'New worktree')
    expect(field('From branch')!.textContent).toContain('josh')

    await act(async () => { primaryButton().click() })
    expect(start).toHaveBeenCalledWith('env-source', 'tab-1', 'env-target', {}, [], { kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'josh' })
  })

  it('moves within this machine without exporting, and refuses the place it already is', async () => {
    await pick('Target environment', 'Laptop')
    expect(primaryButton().textContent).toBe('Move')

    await pick('Worktree', 'Fix the bug')
    expect(host.textContent).toContain('The conversation already lives here.')
    expect(primaryButton().disabled).toBe(true)

    await pick('Worktree', 'Source checkout')
    await act(async () => { primaryButton().click() })
    expect(moveHere).toHaveBeenCalledWith('env-source', 'tab-1', { kind: 'checkout', dir: '/src/ion' })
    expect(start).not.toHaveBeenCalled()
  })

  it('takes the whole worktree only when asked, and then never within this machine', async () => {
    await pick('What moves', 'The whole worktree')
    expect(field('Lands in')).toBeNull()
    expect(field('Worktree')).toBeNull()
    await act(async () => { field('Target environment')!.click() })
    const targets = Array.from(host.querySelectorAll('[role="menuitemradio"]')).map((el) => el.textContent)
    expect(targets.some((t) => t?.startsWith('Laptop'))).toBe(false)
  })
})
