// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationMember, IntegrationWorkspace, TabState, WorktreeInventoryEntry } from '../../../shared/types'
import type { InboxNavigatorGroup } from './inbox-navigator'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const actions = vi.hoisted(() => ({
  benchAddMember: vi.fn(async () => ({ ok: true })),
  benchRemoveMember: vi.fn(async () => undefined),
  syncWorktree: vi.fn(async () => ({ ok: true })),
  benchUpdateMember: vi.fn(async () => ({ ok: true })),
}))
const logger = vi.hoisted(() => ({ rInfo: vi.fn(), rError: vi.fn() }))

const entry: WorktreeInventoryEntry = {
  worktreePath: '/repo/worktree', branchName: 'wt/example', sourceBranch: 'main', label: 'example',
  head: 'abc1234', lastCommitSubject: 'change', isDirty: false, unlandedCommitCount: 0,
  needsSync: false, safeToDiscard: false,
}
const member: IntegrationMember = {
  worktreePath: entry.worktreePath, branchName: entry.branchName, pin: 'current', merge: 'merged',
  pinnedSha: entry.head, pinnedTreeHash: 'tree', pinnedBaseSha: 'base', currentTreeHash: 'tree',
}
const workspace: IntegrationWorkspace = {
  repoPath: '/repo', sourceBranch: 'main', benchPath: '/repo/bench', benchBranch: 'ion/bench/main',
  baseSha: 'base', members: [member], lastAssembly: 'assembled', lastBuiltAt: 1,
}
const state = {
  tabs: [] as TabState[],
  benchWorkspaces: new Map<string, IntegrationWorkspace[]>(),
  worktreePipeline: null,
  worktreeOperations: new Map<string, { kind: string; status: string; repoPath: string; worktreePath?: string; benchPath?: string; message?: string }>(),
  selectTab: vi.fn(),
  syncWorktree: actions.syncWorktree,
  benchUpdateMember: actions.benchUpdateMember,
  benchAddMember: actions.benchAddMember,
  benchRemoveMember: actions.benchRemoveMember,
  refreshWorkspaceViews: vi.fn(),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../components/git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../components/WorktreeRowMenu', () => ({ WorktreeRowMenu: () => null }))
vi.mock('../../components/git/ConflictsDialog', () => ({ ConflictsDialog: () => null }))
vi.mock('../../components/git/BenchConflictDialog', () => ({ BenchConflictDialog: () => null }))
vi.mock('../../components/git/BenchVerificationDialog', () => ({ BenchVerificationDialog: () => null }))
vi.mock('../../rendererLogger', () => logger)

import { InboxWorktreeRow } from './InboxWorktreeRow'

function group(membership?: IntegrationMember): InboxNavigatorGroup {
  return { key: entry.worktreePath, kind: 'worktree', label: 'Example', tabs: [], worktree: entry, membership }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(
  membership?: IntegrationMember,
  entryOverride: WorktreeInventoryEntry = entry,
  overrides: Partial<{
    onSync: (worktreePath: string, sourceBranch: string) => void
    onUpdatePin: (worktreePath: string, sourceBranch: string) => void
    onToggleMembership: (worktreePath: string, sourceBranch: string, enrolled: boolean) => void
  }> = {},
): void {
  act(() => root.render(
    <InboxWorktreeRow
      repoPath="/repo"
      group={{ ...group(membership), worktree: entryOverride }}
      expanded
      onToggle={() => {}}
      onOpen={() => {}}
      onSync={overrides.onSync ?? (() => {})}
      onUpdatePin={overrides.onUpdatePin ?? (() => {})}
      onToggleMembership={overrides.onToggleMembership ?? (() => {})}
    />,
  ))
}
function membershipButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[data-testid="worktree-bench-toggle-${entry.branchName}"]`)!
}
function syncButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(`[data-testid="worktree-sync-${entry.branchName}"]`)
}
function pinBehindButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(`[data-testid="worktree-pin-behind-${entry.branchName}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.benchWorkspaces = new Map()
  state.worktreeOperations = new Map()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('InboxWorktreeRow header actions', () => {
  it('requests enrollment for a non-member worktree, naming its source branch', async () => {
    const onToggleMembership = vi.fn()
    render(undefined, entry, { onToggleMembership })
    await act(async () => { membershipButton().click() })

    expect(onToggleMembership).toHaveBeenCalledWith(entry.worktreePath, 'main', false)
    expect(actions.benchAddMember).not.toHaveBeenCalled()
  })

  it('requests disenrollment for a member worktree, naming the bench it is actually in', async () => {
    const onToggleMembership = vi.fn()
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    render(member, entry, { onToggleMembership })
    await act(async () => { membershipButton().click() })

    expect(onToggleMembership).toHaveBeenCalledWith(entry.worktreePath, 'main', true)
    expect(actions.benchRemoveMember).not.toHaveBeenCalled()
  })

  it('syncs a worktree that needs sync by requesting it from the list', async () => {
    const onSync = vi.fn()
    render(undefined, { ...entry, needsSync: true }, { onSync })
    const button = syncButton()
    expect(button).not.toBeNull()

    await act(async () => { button?.click() })

    expect(onSync).toHaveBeenCalledWith(entry.worktreePath, entry.sourceBranch)
  })

  it('refuses to sync and logs when the source branch is unknown', async () => {
    const onSync = vi.fn()
    render(undefined, { ...entry, needsSync: true, sourceBranch: null }, { onSync })
    // The state slot still resolves to needs-sync (sourceBranch is irrelevant
    // to that decision), so the button renders; the handler is what must catch
    // the missing source branch.
    const button = syncButton()
    expect(button).not.toBeNull()

    await act(async () => { button?.click() })

    expect(onSync).not.toHaveBeenCalled()
    expect(logger.rError).toHaveBeenCalledWith(
      'inbox.worktree', 'sync refused because source branch is missing', expect.any(Object),
    )
  })

  /**
   * Regression: the sync spinner used to read the bulk multi-worktree
   * sync-ALL pipeline's phase (a different feature — InboxBenchBar's "Sync
   * All"), which never enters 'syncing' for a single row's own Sync click.
   * The spinner is now driven by the `syncing` prop the list passes down for
   * THIS worktree specifically.
   */
  it('updates the pin when the workspace resolves via direct membership', async () => {
    const onUpdatePin = vi.fn()
    const behindMember = { ...member, pin: 'behind' as const }
    state.benchWorkspaces = new Map([['/repo', [{ ...workspace, members: [behindMember] }]]])
    render(behindMember, entry, { onUpdatePin })

    const button = pinBehindButton()
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })

    expect(onUpdatePin).toHaveBeenCalledWith(entry.worktreePath, 'main')
  })

  /**
   * Regression for the button that looked clickable but silently did nothing.
   *
   * `group.membership` is set (so the state slot shows "pin behind" and the
   * button renders) but NO workspace in `benchWorkspaces` has a member
   * matching this worktree path directly — the exact shape
   * `inbox-navigator.ts` produces when a worktree's membership comes from a
   * bench that is not the repo's currently-selected one. Before the fix,
   * `workspace` stayed undefined here and `updatePin` returned with no log.
   */
  it('updates the pin when membership is known only through the group fallback', async () => {
    const onUpdatePin = vi.fn()
    const behindMember = { ...member, pin: 'behind' as const }
    // The workspace exists (so the click handler CAN resolve it by source
    // branch), but its members array does not list this worktree — only
    // `group.membership` (computed upstream) knows about the membership.
    state.benchWorkspaces = new Map([['/repo', [{ ...workspace, members: [] }]]])
    render(behindMember, entry, { onUpdatePin })

    const button = pinBehindButton()
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })

    expect(onUpdatePin).toHaveBeenCalledWith(entry.worktreePath, 'main')
  })

  it('refuses to update the pin and logs when no bench workspace resolves at all', async () => {
    const onUpdatePin = vi.fn()
    const behindMember = { ...member, pin: 'behind' as const }
    state.benchWorkspaces = new Map()
  state.worktreeOperations = new Map()
    render(behindMember, entry, { onUpdatePin })

    const button = pinBehindButton()
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })

    expect(onUpdatePin).not.toHaveBeenCalled()
    expect(logger.rError).toHaveBeenCalledWith(
      'inbox.worktree', 'pin update refused because no bench workspace resolved', expect.any(Object),
    )
  })

  it('disables shared controls while the operation ledger owns the worktree', () => {
    state.worktreeOperations = new Map([['sync', { kind: 'sync', status: 'running', repoPath: '/repo', worktreePath: entry.worktreePath, message: 'Syncing' }]])
    render(undefined, { ...entry, needsSync: true })
    expect(syncButton()?.disabled).toBe(true)
    expect(host.querySelector(`[data-testid="worktree-bench-toggle-${entry.branchName}"]`)?.hasAttribute('disabled')).toBe(true)
  })

  /**
   * Regression: a worktree that is BOTH behind its base and ahead of its bench
   * pin showed only the sync control, so the pin could never be advanced from
   * the row. That is the steady state of any long-lived worktree — the observed
   * case was a bench holding nine-hour-old content for a member that had
   * committed four times since — and it left the operator with no surface for
   * the pin at all.
   *
   * Sync still ranks first (a rebase rewrites the commits, so a pin taken
   * before it is immediately stale), but both controls are present.
   */
  it('offers BOTH sync and pin update when the base moved and the pin is behind', async () => {
    const onSync = vi.fn()
    const onUpdatePin = vi.fn()
    const behindMember = { ...member, pin: 'behind' as const }
    state.benchWorkspaces = new Map([['/repo', [{ ...workspace, members: [behindMember] }]]])
    render(behindMember, { ...entry, needsSync: true }, { onSync, onUpdatePin })

    expect(syncButton()).not.toBeNull()
    const pin = pinBehindButton()
    expect(pin).not.toBeNull()

    await act(async () => { pin?.click() })
    expect(onUpdatePin).toHaveBeenCalledWith(entry.worktreePath, 'main')

    await act(async () => { syncButton()?.click() })
    expect(onSync).toHaveBeenCalledWith(entry.worktreePath, entry.sourceBranch)
  })

  it('shows only sync when the base moved but the pin is current', () => {
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    render(member, { ...entry, needsSync: true })
    expect(syncButton()).not.toBeNull()
    expect(pinBehindButton()).toBeNull()
  })

  /**
   * The dirty marker is the row's only signal that a worktree holds uncommitted
   * work, and it was invisible for hours because nothing re-read git after the
   * Inbox first mounted. The rendering itself must not be the weak link.
   */
  it('marks a dirty worktree', () => {
    render(undefined, { ...entry, isDirty: true })
    expect(host.textContent).toContain('!')
  })

})
