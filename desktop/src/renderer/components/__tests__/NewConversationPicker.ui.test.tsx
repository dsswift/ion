// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createTabInDirectory = vi.fn().mockResolvedValue('tab-plain')
const createConversationTab = vi.fn().mockResolvedValue('tab-profile')
const addProject = vi.fn()
const listEngineDirectory = vi.fn()
const gitWorktreeInventory = vi.fn()
const gitIsRepo = vi.fn().mockResolvedValue({ isRepo: true })
const gitFetch = vi.fn().mockResolvedValue({ ok: true })
const gitBranches = vi.fn()
const close = vi.fn()

const preferenceState = {
  projects: {
    '/work/ion': { addedManually: false, lastUsedAt: 2 },
    '/work/t3code': { addedManually: true, lastUsedAt: 1 },
  },
  engineProfiles: [{ id: 'dev', name: 'Development', extensions: ['ext/dev'] }],
  defaultEngineProfileId: '',
  enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string },
  addProject,
}

vi.mock('../../theme', () => ({
  useColors: () => ({ scrim: 'rgba(0,0,0,.2)', popoverBg: '#111', popoverBorder: '#222', popoverShadow: 'none', textPrimary: '#fff', textSecondary: '#ccc', textTertiary: '#999', tabActive: '#333' }),
}))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (state: typeof preferenceState) => unknown) => selector(preferenceState),
    { getState: () => preferenceState },
  ),
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ createTabInDirectory, createConversationTab }) },
}))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rError: vi.fn() }))

import { NewConversationPicker } from '../NewConversationPicker'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(props: React.ComponentProps<typeof NewConversationPicker> = { onClose: close }): void {
  root = createRoot(container)
  act(() => { root.render(<NewConversationPicker {...props} />) })
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  preferenceState.enterpriseNewConversationDefaults = null
  preferenceState.engineProfiles = [{ id: 'dev', name: 'Development', extensions: ['ext/dev'] }]
  container = document.createElement('div')
  document.body.appendChild(container)
  Object.assign(window, { ion: { listEngineDirectory, gitIsRepo, gitWorktreeInventory, gitFetch, gitBranches } })
  gitWorktreeInventory.mockResolvedValue({ worktrees: [] })
  gitBranches.mockResolvedValue({ current: 'main', branches: [{ name: 'main', isRemote: false }, { name: 'release', isRemote: false }] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('NewConversationPicker', () => {
  it('renders a centered modal and filters loaded projects', async () => {
    render()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    const input = document.querySelector('input[aria-label="New conversation search"]') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    await act(async () => { setInput(input, 't3'); await Promise.resolve() })
    expect(document.body.textContent).toContain('t3code')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.startsWith('ion'))).toBe(false)
  })

  it('opens the profile view for a chosen project and returns with the back arrow', async () => {
    render()
    const ion = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('ion'))!
    await act(async () => { ion.click(); await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Source repository')
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Source repository'))?.click() })
    expect(document.body.textContent).toContain('Plain conversation')
    await act(async () => { (document.querySelector('[aria-label="Back"]') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Source repository')
  })

  it('lists a typed path and adds the resolved directory before opening it', async () => {
    listEngineDirectory.mockResolvedValue({ ok: true, data: { path: '/work', parent: '/', truncated: false, entries: [{ name: 'new-project', isDir: true, isSymlink: false, readable: true }] } })
    render()
    const input = document.querySelector('input[aria-label="New conversation search"]') as HTMLInputElement
    await act(async () => { setInput(input, '/work/new-project'); await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Add and use this directory')
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Add and use'))?.click() })
    expect(addProject).toHaveBeenCalledWith('/work/new-project')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Source repository')
  })

  it('creates a conversation in an existing worktree after profile selection', async () => {
    gitWorktreeInventory.mockResolvedValue({ worktrees: [{ worktreePath: '/worktrees/feature', branchName: 'wt/feature', label: 'feature', title: 'Feature work', sourceBranch: 'main', head: 'abc', lastCommitSubject: '', isDirty: false, unlandedCommitCount: 0, needsSync: false, safeToDiscard: false }] })
    render()
    const ion = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('ion'))!
    await act(async () => { ion.click(); await Promise.resolve(); await Promise.resolve() })
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Feature work'))?.click() })
    const plain = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Plain conversation'))!
    await act(async () => { plain.click(); await Promise.resolve() })

    expect(createConversationTab).toHaveBeenCalledWith('/worktrees/feature', expect.objectContaining({
      worktree: expect.objectContaining({ repoPath: '/work/ion', worktreePath: '/worktrees/feature' }),
    }))
  })

  it('opens at conversation type for a known existing worktree', async () => {
    const worktree = {
      repoPath: '/work/ion',
      worktreePath: '/worktrees/feature',
      branchName: 'wt/feature',
      sourceBranch: 'main',
    }
    render({ initialDirectory: worktree.worktreePath, initialWorktree: worktree, onClose: close })

    expect(document.body.textContent).toContain('Choose conversation type')
    expect(document.body.textContent).toContain('Plain conversation')
    expect(document.body.textContent).toContain('Development')
    expect(document.body.textContent).not.toContain('Source repository')

    const profile = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Development'))!
    await act(async () => { profile.click(); await Promise.resolve() })

    expect(createConversationTab).toHaveBeenCalledWith(worktree.worktreePath, expect.objectContaining({
      profileId: 'dev',
      worktree,
    }))
  })

  it('creates the only available type without showing the type picker', async () => {
    preferenceState.engineProfiles = []
    render({
      initialDirectory: '/worktrees/feature',
      initialWorktree: {
        repoPath: '/work/ion',
        worktreePath: '/worktrees/feature',
        branchName: 'wt/feature',
        sourceBranch: 'main',
      },
      onClose: close,
    })
    await act(async () => { await Promise.resolve() })

    expect(document.body.textContent).not.toContain('Choose conversation type')
    expect(createConversationTab).toHaveBeenCalledWith('/worktrees/feature', expect.objectContaining({
      worktree: expect.objectContaining({ worktreePath: '/worktrees/feature' }),
    }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('applies enterprise policy to a known worktree without showing the type picker', async () => {
    preferenceState.enterpriseNewConversationDefaults = {
      locked: true,
      baseDirectory: '/corp/project',
      engineProfileId: 'corp-profile',
    }
    render({
      initialDirectory: '/worktrees/feature',
      initialWorktree: {
        repoPath: '/work/ion',
        worktreePath: '/worktrees/feature',
        branchName: 'wt/feature',
        sourceBranch: 'main',
      },
      onClose: close,
    })
    await act(async () => { await Promise.resolve() })

    expect(createConversationTab).toHaveBeenCalledWith('/corp/project', { profileId: 'corp-profile' })
    expect(document.body.textContent).not.toContain('Choose conversation type')
  })

  it('enforces an enterprise-locked directory and profile after workspace selection', async () => {
    preferenceState.enterpriseNewConversationDefaults = {
      locked: true,
      baseDirectory: '/corp/project',
      engineProfileId: 'corp-profile',
    }
    render()
    const ion = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('ion'))!
    await act(async () => { ion.click(); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Source repository'))?.click(); await Promise.resolve() })

    expect(createConversationTab).toHaveBeenCalledWith('/corp/project', expect.objectContaining({ profileId: 'corp-profile' }))
    expect(document.body.textContent).not.toContain('Plain conversation')
  })

  it('creates a new worktree from the selected source branch', async () => {
    render()
    const ion = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('ion'))!
    await act(async () => { ion.click(); await Promise.resolve(); await Promise.resolve() })
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Create a new worktree'))?.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('release'))?.click() })
    const plain = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Plain conversation'))!
    await act(async () => { plain.click(); await Promise.resolve() })

    expect(createConversationTab).toHaveBeenCalledWith('/work/ion', expect.objectContaining({ useWorktree: true, sourceBranch: 'release' }))
  })
})
