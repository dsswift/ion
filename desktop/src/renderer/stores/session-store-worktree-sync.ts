import type { StoreApi } from 'zustand'
import type { State } from './session-store-types'
import type { IntegrationMember, IntegrationWorkspace, WorktreeInventoryEntry } from '../../shared/types'
import type {
  StudioGitConflictAlert,
  StudioWorkspaceOperation,
  StudioWorktreePipeline,
  StudioWorktreeSnapshot,
} from '../../shared/types-studio'
import { rDebug, rWarn } from '../rendererLogger'

export type WorkspaceOperationStatus = StudioWorkspaceOperation['status']

/** Owner-executed worktree or bench mutation, retained for Studio progress UI. */
export interface WorkspaceOperation extends StudioWorkspaceOperation {
  repoPath?: string
  sourceBranch?: string
  worktreePath?: string
  benchPath?: string
}

/** Serializable owner projection carried in the existing Studio tabs snapshot. */
export interface StudioWorkspaceSnapshot {
  version: 1
  worktreeInventory: Array<[string, WorktreeInventoryEntry[]]>
  benchWorkspaces: Array<[string, IntegrationWorkspace[]]>
  benchSourceTips: Array<[string, Record<string, string>]>
  benchRetired: Array<[string, Array<[string, IntegrationMember[]]>]>
  gitConflictAlerts: Array<[string, StudioGitConflictAlert]>
  worktreePipeline: StudioWorktreePipeline | null
  operationLedger: StudioWorkspaceOperation[]
}

type WorkspaceState = Pick<State,
  'worktreeInventory' | 'benchWorkspaces' | 'benchSourceTips' | 'benchRetired' |
  'gitConflictAlerts' | 'worktreePipeline' | 'workspaceOperationLedger'>

export function projectStudioWorkspaceSnapshot(state: WorkspaceState): StudioWorkspaceSnapshot {
  return {
    version: 1,
    worktreeInventory: [...state.worktreeInventory],
    benchWorkspaces: [...state.benchWorkspaces],
    benchSourceTips: [...state.benchSourceTips],
    benchRetired: [...state.benchRetired].map(([repoPath, entries]) => [repoPath, [...entries]]),
    gitConflictAlerts: [...state.gitConflictAlerts],
    worktreePipeline: state.worktreePipeline as StudioWorktreePipeline | null,
    operationLedger: [...state.workspaceOperationLedger.values()],
  }
}

/** Project owner store state into the desktop-internal Studio IPC contract. */
export function projectStudioWorktreeSnapshot(
  state: WorkspaceState,
  ready: boolean,
): Omit<StudioWorktreeSnapshot, 'revision'> {
  return {
    ready,
    inventory: Object.fromEntries(state.worktreeInventory),
    workspaces: Object.fromEntries(state.benchWorkspaces),
    benchSourceTips: [...state.benchSourceTips],
    benchRetired: [...state.benchRetired].map(([repoPath, entries]) => [repoPath, [...entries]]),
    gitConflictAlerts: [...state.gitConflictAlerts],
    worktreePipeline: state.worktreePipeline as StudioWorktreePipeline | null,
    workspaceOperationLedger: [...state.workspaceOperationLedger.values()],
  }
}

/** Publish exactly when owner worktree state changes, never through tab persistence. */
export function setupStudioWorktreeSync(store: StoreApi<State>): () => void {
  let ready = false
  const publish = (state: State): void => {
    const publishSnapshot = window.ion?.studioPublishWorktreeSync
    if (typeof publishSnapshot !== 'function') {
      rWarn('studio.worktree-sync', 'owner worktree snapshot bridge unavailable')
      return
    }
    publishSnapshot(projectStudioWorktreeSnapshot(state, ready))
    rDebug('studio.worktree-sync', 'owner worktree snapshot published', {
      ready: String(ready),
      repositories: state.worktreeInventory.size,
      operations: state.workspaceOperationLedger.size,
    })
  }

  publish(store.getState())
  return store.subscribe((state, previous) => {
    if (!ready && state.tabsReady) {
      ready = true
      publish(state)
      return
    }
    if (
      state.worktreeInventory !== previous.worktreeInventory ||
      state.benchWorkspaces !== previous.benchWorkspaces ||
      state.benchSourceTips !== previous.benchSourceTips ||
      state.benchRetired !== previous.benchRetired ||
      state.gitConflictAlerts !== previous.gitConflictAlerts ||
      state.worktreePipeline !== previous.worktreePipeline ||
      state.workspaceOperationLedger !== previous.workspaceOperationLedger
    ) publish(state)
  })
}

/** Convert the structured-clone snapshot back into the mirror's native Maps. */
export function applyStudioWorktreeSnapshot(
  snapshot: StudioWorktreeSnapshot,
  setState: (state: Partial<State>) => void,
): void {
  setState({
    worktreeInventory: new Map(Object.entries(snapshot.inventory)),
    benchWorkspaces: new Map(Object.entries(snapshot.workspaces)),
    benchSourceTips: new Map(snapshot.benchSourceTips),
    benchRetired: new Map(snapshot.benchRetired.map(([repoPath, entries]) => [repoPath, new Map(entries)])),
    gitConflictAlerts: new Map(snapshot.gitConflictAlerts),
    worktreePipeline: snapshot.worktreePipeline as State['worktreePipeline'],
    workspaceOperationLedger: new Map(snapshot.workspaceOperationLedger.map((operation) => [operation.id, operation])),
  })
}

export function isStudioWorkspaceSnapshot(value: unknown): value is StudioWorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<StudioWorkspaceSnapshot>
  return snapshot.version === 1 &&
    Array.isArray(snapshot.worktreeInventory) &&
    Array.isArray(snapshot.benchWorkspaces) &&
    Array.isArray(snapshot.benchSourceTips) &&
    Array.isArray(snapshot.benchRetired) &&
    Array.isArray(snapshot.gitConflictAlerts) &&
    Array.isArray(snapshot.operationLedger)
}
