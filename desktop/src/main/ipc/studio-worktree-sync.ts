import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { StudioWorktreeSnapshot } from '../../shared/types-studio'
import { broadcast } from '../broadcast'
import { log } from '../logger'
import { state } from '../state'

let worktreeSnapshot: StudioWorktreeSnapshot | null = null
let worktreeRevision = 0

const PIPELINE_PHASES = new Set([
  'syncing',
  'awaiting-ai-confirm',
  'resolving',
  'assembling',
  'done',
  'failed',
])
const OPERATION_STATUSES = new Set(['running', 'succeeded', 'failed'])
const ALERT_SOURCES = new Set(['sync', 'land', 'detected'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

function isRecordOfArrays(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(Array.isArray)
}

function isTupleArray(value: unknown, item: (value: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(item)
}

function isBenchSourceTips(value: unknown): boolean {
  return isTupleArray(value, (item) =>
    Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && isStringRecord(item[1]),
  )
}

function isBenchRetired(value: unknown): boolean {
  return isTupleArray(value, (item) =>
    Array.isArray(item) &&
    item.length === 2 &&
    typeof item[0] === 'string' &&
    isTupleArray(item[1], (entry) =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && Array.isArray(entry[1]),
    ),
  )
}

function isConflictAlerts(value: unknown): boolean {
  return isTupleArray(value, (item) => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !isRecord(item[1])) return false
    const alert = item[1]
    return ALERT_SOURCES.has(alert.source as string) &&
      typeof alert.dismissed === 'boolean' &&
      typeof alert.recordedAt === 'number' && Number.isFinite(alert.recordedAt)
  })
}

function isWorktreePipeline(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value)) return false
  return typeof value.repoPath === 'string' &&
    (typeof value.sourceBranch === 'string' || value.sourceBranch === null) &&
    PIPELINE_PHASES.has(value.phase as string) &&
    Array.isArray(value.outcomes) &&
    Array.isArray(value.queue) && value.queue.every((item) => typeof item === 'string') &&
    (typeof value.current === 'string' || value.current === null) &&
    Array.isArray(value.needsManual) && value.needsManual.every((item) => typeof item === 'string') &&
    typeof value.resolvedByAi === 'number' && Number.isFinite(value.resolvedByAi) &&
    typeof value.cancelled === 'boolean' &&
    typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
}

function isOperationLedger(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!isRecord(item)) return false
    return typeof item.id === 'string' &&
      typeof item.action === 'string' &&
      OPERATION_STATUSES.has(item.status as string) &&
      typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) &&
      (item.completedAt === undefined || (typeof item.completedAt === 'number' && Number.isFinite(item.completedAt))) &&
      (item.error === undefined || typeof item.error === 'string')
  })
}

function isWorktreeSnapshot(value: unknown): value is Omit<StudioWorktreeSnapshot, 'revision'> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const expectedKeys = [
    'ready',
    'inventory',
    'workspaces',
    'benchSourceTips',
    'benchRetired',
    'gitConflictAlerts',
    'worktreePipeline',
    'workspaceOperationLedger',
  ]
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key)) &&
    typeof value.ready === 'boolean' &&
    isRecordOfArrays(value.inventory) &&
    isRecordOfArrays(value.workspaces) &&
    isBenchSourceTips(value.benchSourceTips) &&
    isBenchRetired(value.benchRetired) &&
    isConflictAlerts(value.gitConflictAlerts) &&
    isWorktreePipeline(value.worktreePipeline) &&
    isOperationLedger(value.workspaceOperationLedger)
}

/**
 * Connect the owner renderer's complete worktree projection to the Studio
 * mirror. Main assigns revisions and only accepts the overlay owner as source.
 */
export function registerStudioWorktreeSyncIpc(): void {
  ipcMain.on(IPC.STUDIO_PUBLISH_WORKTREE_SYNC, (event, snapshot: unknown) => {
    const owner = state.mainWindow
    if (!owner || owner.isDestroyed() || event.sender.id !== owner.webContents.id) {
      log('studio_worktree_sync', 'publish rejected, sender is not owner', {
        sender_id: event.sender.id,
        owner_id: owner?.isDestroyed() ? null : owner?.webContents.id ?? null,
      })
      return
    }
    if (!isWorktreeSnapshot(snapshot)) {
      log('studio_worktree_sync', 'publish rejected, invalid snapshot', {
        sender_id: event.sender.id,
      })
      return
    }

    worktreeSnapshot = {
      ...snapshot,
      revision: ++worktreeRevision,
    }
    log('studio_worktree_sync', 'snapshot accepted', {
      revision: worktreeSnapshot.revision,
      ready: worktreeSnapshot.ready,
      repositories: Object.keys(worktreeSnapshot.inventory).length,
      workspace_repositories: Object.keys(worktreeSnapshot.workspaces).length,
      conflict_alerts: worktreeSnapshot.gitConflictAlerts.length,
      operation_ledger_entries: worktreeSnapshot.workspaceOperationLedger.length,
    })
    broadcast(IPC.STUDIO_WORKTREE_SYNC, worktreeSnapshot)
  })

  ipcMain.handle(IPC.STUDIO_GET_WORKTREE_SYNC, () => worktreeSnapshot)
}
