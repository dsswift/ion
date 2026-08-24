/**
 * Questions persistence — versioned, atomic on-disk records for the
 * main-owned QuestionsCoordinator under ~/.ion/questions/.
 *
 * One JSON file per workflow, named by a hash of the workflowId (unsafe
 * client-supplied identifiers never become path segments). Records survive a
 * desktop restart: a parked question is durable by design (nothing is
 * running while it waits, and submission is an ordinary prompt), so restored
 * records render immediately; the coordinator's idle-denials reconcile
 * retires any the engine reports superseded.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import type { QuestionsWorkflowState } from '../../shared/questions-state'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'questions-persist'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Bumped when the record shape changes; older versions are dropped on load. */
const RECORD_VERSION = 1

interface QuestionsRecord {
  version: number
  workflow: QuestionsWorkflowState
}

function questionsDir(): string {
  return join(homedir(), '.ion', 'questions')
}

function recordPath(workflowId: string): string {
  const digest = createHash('sha256').update(workflowId).digest('hex').slice(0, 32)
  return join(questionsDir(), `wf-${digest}.json`)
}

/** Persist one workflow record atomically (temp + fsync + rename). */
export function persistWorkflow(workflow: QuestionsWorkflowState): void {
  try {
    mkdirSync(questionsDir(), { recursive: true })
    const record: QuestionsRecord = { version: RECORD_VERSION, workflow }
    atomicWriteFileSync(recordPath(workflow.workflowId), JSON.stringify(record))
  } catch (err) {
    // Persistence failure must not break the live workflow — the in-memory
    // coordinator stays authoritative for this desktop lifetime; only
    // restart durability is lost. Loud so the gap is queryable.
    warn('workflow persist failed', { workflow_id: workflow.workflowId, error: String(err) })
  }
}

/** Remove one workflow's record (terminal retirement). */
export function removeWorkflowRecord(workflowId: string): void {
  try {
    rmSync(recordPath(workflowId), { force: true })
  } catch (err) {
    warn('workflow record remove failed', { workflow_id: workflowId, error: String(err) })
  }
}

/**
 * Load every persisted workflow. Invalid or
 * version-mismatched files are dropped (and deleted — they can never be
 * confirmed). Called once before renderer hydration.
 */
export function loadPersistedWorkflows(): QuestionsWorkflowState[] {
  const dir = questionsDir()
  if (!existsSync(dir)) return []
  const restored: QuestionsWorkflowState[] = []
  let dropped = 0
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('wf-') && f.endsWith('.json'))
  } catch (err) {
    warn('questions dir read failed', { error: String(err) })
    return []
  }
  for (const file of files) {
    const path = join(dir, file)
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as QuestionsRecord
      if (record.version !== RECORD_VERSION || !record.workflow?.workflowId) {
        rmSync(path, { force: true })
        dropped++
        continue
      }
      // Terminal records need no restoration; delete opportunistically.
      if (record.workflow.phase === 'terminal') {
        rmSync(path, { force: true })
        continue
      }
      restored.push(record.workflow)
    } catch (err) {
      warn('workflow record unreadable, dropping', { file, error: String(err) })
      rmSync(path, { force: true })
      dropped++
    }
  }
  log('persisted workflows loaded', { restored: restored.length, dropped })
  return restored
}
