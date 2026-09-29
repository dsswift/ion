// @vitest-environment jsdom
/**
 * The Workflow page sections. Git: the settings write through, Skip PR title
 * shows only for pull requests, branch defaults hide when empty, and the
 * ignored-directories editor talks about directories (it once reused the
 * Bash allowlist editor and said "Bash is blocked" for an empty list).
 * Inbox: a change that could settle conversations asks first, in a panel
 * that lists them; a failed preview changes nothing. Quick tools: add and
 * edit in a side panel, and the project's own tools are listed read-only.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuickTool } from '@ion/shared/types'
import type { ProjectStudioConfigSnapshot } from '@ion/shared/project-studio-config'
import { createHarness, flush, type Harness } from './page-harness'

const hostAction = vi.hoisted(() => vi.fn())
const project = vi.hoisted(() => ({ snapshot: { root: null, quickTools: [], toolsHash: '', trusted: false } as ProjectStudioConfigSnapshot }))

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../host/host-instance', () => ({ action: hostAction, host: {} }))
vi.mock('../../../composer/useProjectStudioConfig', () => ({ useProjectStudioConfig: () => ({ snapshot: project.snapshot, directory: '', reload: () => {} }) }))
vi.mock('../../settings-target', async () => {
  const { create } = await import('zustand')
  return { useSettingsPreferences: create<Record<string, unknown>>(() => ({})), useSettingsTargetEnvironmentId: () => 'local' }
})

const { useSettingsPreferences } = await import('../../settings-target')
const { GitWorkflowSection, IGNORED_DIRECTORIES_EMPTY_TEXT } = await import('../workflow/GitWorkflowSection')
const { InboxSection } = await import('../workflow/InboxSection')
const { QuickToolsSection } = await import('../workflow/QuickToolsSection')

const store = useSettingsPreferences as unknown as { setState(s: object, replace?: boolean): void; getState(): Record<string, unknown> }
const setters = {
  setGitOpsMode: vi.fn(), setWorktreeCompletionStrategy: vi.fn(), setWorktreeSkipPrTitle: vi.fn(), removeWorktreeBranchDefault: vi.fn(),
  setCommitCommand: vi.fn(), setGitWatcherIgnoredDirectories: vi.fn(), setInboxAutoSettleDays: vi.fn(), setInboxAutoSettleOnMerge: vi.fn(),
  addQuickTool: vi.fn(), updateQuickTool: vi.fn(), removeQuickTool: vi.fn(),
}

let h: Harness
beforeEach(() => {
  vi.clearAllMocks()
  project.snapshot = { root: null, quickTools: [], toolsHash: '', trusted: false }
  store.setState({
    ...setters,
    gitOpsMode: 'worktree', worktreeCompletionStrategy: 'merge', worktreeSkipPrTitle: false, worktreeBranchDefaults: {},
    commitCommand: '', gitWatcherIgnoredDirectories: [], inboxAutoSettleDays: 0, inboxAutoSettleOnMerge: false, quickTools: [],
  }, true)
  h = createHarness()
})
afterEach(() => {
  h.unmount()
  document.querySelectorAll('[role="menu"]').forEach((m) => m.remove())
})

const text = (): string => h.container.textContent ?? ''
const rows = (list: string): HTMLElement[] => [...h.container.querySelectorAll<HTMLElement>(`[aria-label="${list}"] [role="listitem"]`)]
async function type(label: string, value: string): Promise<void> {
  const input = h.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`no input ${label}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('GitWorkflowSection', () => {
  it('writes each setting through and shows Skip PR title only for pull requests', async () => {
    await h.render(<GitWorkflowSection />)
    expect(h.maybeControl('Skip PR title prompt')).toBeUndefined()
    await h.click('Manual')
    expect(setters.setGitOpsMode).toHaveBeenCalledWith('manual')
    await h.click('Pull request')
    expect(setters.setWorktreeCompletionStrategy).toHaveBeenCalledWith('pr')
    await type('Commit command', 'commit --smart')
    expect(setters.setCommitCommand).toHaveBeenCalledWith('commit --smart')
    await act(async () => { store.setState({ worktreeCompletionStrategy: 'pr' }); await flush() })
    await h.click('Skip PR title prompt')
    expect(setters.setWorktreeSkipPrTitle).toHaveBeenCalledWith(true)
  })

  it('hides branch defaults when empty and removes one from its row menu', async () => {
    await h.render(<GitWorkflowSection />)
    expect(h.container.querySelector('[aria-label="Branch defaults"]')).toBeNull()
    await act(async () => { store.setState({ worktreeBranchDefaults: { '/Users/someone/src/app': 'main' } }); await flush() })
    const [row] = rows('Branch defaults')
    expect(row.textContent).toContain('~/src/app')
    expect(row.textContent).toContain('main')
    await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find((b) => b.textContent === 'Remove')?.click(); await flush() })
    expect(setters.removeWorktreeBranchDefault).toHaveBeenCalledWith('/Users/someone/src/app')
  })

  it('an empty ignored-directories list talks about directories, not Bash', async () => {
    await h.render(<GitWorkflowSection />)
    expect(text()).toContain('None where the git file watcher stays quiet')
    await h.click('Edit')
    expect(text()).toContain(IGNORED_DIRECTORIES_EMPTY_TEXT)
    expect(text()).not.toContain('Bash')
    expect(text()).not.toContain('No commands allowed')
    await type('Add to Ignored directories', '~/.ion')
    await h.click('Add')
    expect(setters.setGitWatcherIgnoredDirectories).toHaveBeenCalledWith(['~/.ion'])
  })
})

describe('InboxSection', () => {
  it('asks before a change that settles conversations, listing them, and applies on confirm', async () => {
    hostAction.mockResolvedValue({ count: 4, titles: ['Alpha', 'Beta'] })
    await h.render(<InboxSection />)
    await h.click('Auto-settle inactive conversations')
    expect(hostAction).toHaveBeenCalledWith('local', 'inbox.previewAutoSettle', [{ days: 3 }])
    expect(setters.setInboxAutoSettleDays).not.toHaveBeenCalled()
    expect(text()).toContain('This will settle 4 conversations right away.')
    expect(text()).toContain('Alpha')
    expect(text()).toContain('and 2 more')
    await h.click('Settle them and turn this on')
    expect(setters.setInboxAutoSettleDays).toHaveBeenCalledWith(3)
    expect(h.container.querySelector('aside')).toBeNull()
  })

  it('cancel leaves the setting off', async () => {
    hostAction.mockResolvedValue({ count: 1, titles: ['Alpha'] })
    await h.render(<InboxSection />)
    await h.click('Auto-settle inactive conversations')
    await h.click('Cancel')
    expect(setters.setInboxAutoSettleDays).not.toHaveBeenCalled()
    expect((h.control('Auto-settle inactive conversations')).getAttribute('aria-checked')).toBe('false')
  })

  it('a failed preview changes nothing and says so', async () => {
    hostAction.mockRejectedValue(new Error('offline'))
    await h.render(<InboxSection />)
    await h.click('Auto-settle inactive conversations')
    expect(setters.setInboxAutoSettleDays).not.toHaveBeenCalled()
    expect(text()).toContain('Could not check what this would settle, so nothing was changed.')
  })

  it('turning it off needs no preview; merged pull requests toggle directly', async () => {
    store.setState({ inboxAutoSettleDays: 5 })
    await h.render(<InboxSection />)
    expect(h.container.querySelector('input[aria-label="Days of inactivity before auto-settle"]')).not.toBeNull()
    await h.click('Auto-settle inactive conversations')
    expect(hostAction).not.toHaveBeenCalled()
    expect(setters.setInboxAutoSettleDays).toHaveBeenCalledWith(0)
    await h.click('Auto-settle merged pull requests')
    expect(setters.setInboxAutoSettleOnMerge).toHaveBeenCalledWith(true)
  })
})

describe('QuickToolsSection', () => {
  const deploy: QuickTool = { id: 't1', name: 'Deploy', icon: 'Rocket', command: 'make deploy', directories: ['/src/app'] }

  it('adds a tool from the side panel with the chosen icon', async () => {
    await h.render(<QuickToolsSection />)
    await h.click('Add tool')
    expect((h.control('Save') as HTMLButtonElement).disabled).toBe(true)
    await type('Tool name', ' Sync ')
    await type('Tool command', 'git pull')
    await h.click('GitBranch')
    await h.click('Save')
    expect(setters.addQuickTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sync', command: 'git pull', icon: 'GitBranch' }))
    expect(setters.addQuickTool.mock.calls[0][0]).not.toHaveProperty('directories')
  })

  it('edits a tool from its row and deletes from the row menu', async () => {
    store.setState({ quickTools: [deploy] })
    await h.render(<QuickToolsSection />)
    const [row] = rows('Quick tools')
    expect(row.textContent).toContain('make deploy')
    await act(async () => { row.click(); await flush() })
    expect(h.container.querySelector<HTMLInputElement>('input[aria-label="Tool name"]')?.value).toBe('Deploy')
    expect(text()).toContain('/src/app')
    await type('Tool command', 'make deploy-staging')
    await h.click('Save')
    expect(setters.updateQuickTool).toHaveBeenCalledWith('t1', { id: 't1', name: 'Deploy', icon: 'Rocket', command: 'make deploy-staging', directories: ['/src/app'] })
    await act(async () => { (rows('Quick tools')[0].querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find((b) => b.textContent === 'Delete')?.click(); await flush() })
    expect(setters.removeQuickTool).toHaveBeenCalledWith('t1')
  })

  it('lists the project’s tools read-only with trust and a refusal', async () => {
    project.snapshot = { root: '/src/app', quickTools: [{ id: 'p1', name: 'Lint', icon: 'Code', command: 'npm run lint' }], toolsHash: 'h', trusted: false, error: 'bad json' } as ProjectStudioConfigSnapshot
    await h.render(<QuickToolsSection />)
    const [row] = rows('From this project')
    expect(row.textContent).toContain('npm run lint')
    expect(row.querySelector('[aria-label="More actions"]')).toBeNull()
    expect(text()).toContain('.ion/studio.json at /src/app')
    expect(text()).toContain('You have not trusted this list yet')
    expect(text()).toContain('The file was refused, so it grants no tools: bad json.')
  })
})
