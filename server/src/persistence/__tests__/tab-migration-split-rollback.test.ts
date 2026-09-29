// @vitest-environment node
/**
 * tab-migration-split-runner — deterministic rollback / restore tests.
 *
 * ADR-011 mandates that the migration is rollback-safe: a verify failure must
 * leave the original file unchanged, and a write failure mid-flight must
 * restore the file from the backup. The end-to-end test in
 * tab-migration-split-runner.test.ts exercises the happy path and idempotency,
 * but its "rollback" case is hedged (the collision fixture actually passes
 * verify, so the rollback assertions never execute) and the post-write
 * `copyFileSync` restore branch was untested.
 *
 * These tests force both failure paths deterministically by mocking the
 * transform and the atomic writer, so the safety net ADR-011 promises is
 * actually pinned.
 *
 * Regression contract
 * ───────────────────
 *  - Verify-failure test: remove the `if (problem) { ... return verify-failed }`
 *    gate in the runner and the runner writes corrupt content → the
 *    "original unchanged" assertion goes red.
 *  - Write-failure test: remove the `copyFileSync(backupPath, tabsPath)`
 *    restore in the catch block and the file is left half-written / missing →
 *    the "restored from backup" assertion goes red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PersistedTabState } from '@ion/shared/types-persistence'

// Mock the transform + atomic writer so we can force verify and write failures.
const migrateMock = vi.fn()
const atomicWriteMock = vi.fn()

vi.mock('../tab-migration-split', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tab-migration-split')>()
  return {
    ...actual,
    migrateTabStateToSplit: (...a: any[]) => migrateMock(...a),
  }
})

vi.mock('../../utils/atomicWrite', () => ({
  atomicWriteFileSync: (...a: any[]) => atomicWriteMock(...a),
}))

import { runTabSplitMigration } from '../tab-migration-split-runner'

// A unified (schemaVersion 2) input with one genuinely multi-instance tab,
// so the runner enters the backup/migrate/verify/write pipeline.
function multiInstanceInput(): PersistedTabState {
  return {
    schemaVersion: 2,
    activeSessionId: null,
    tabs: [
      {
        conversationId: null,
        title: 'Tab',
        customTitle: null,
        workingDirectory: '/p',
        hasChosenDirectory: true,
        additionalDirs: [],
        permissionMode: 'auto',
        engineProfileId: 'profile-1',
        conversationPane: {
          instances: [
            { id: 'a', label: 'A', messages: [], messageCount: 0, modelOverride: null, permissionMode: 'auto', conversationIds: ['c-a'], draftInput: '', agentStates: [], forkedFromConversationIds: null },
            { id: 'b', label: 'B', messages: [], messageCount: 0, modelOverride: null, permissionMode: 'auto', conversationIds: ['c-b'], draftInput: '', agentStates: [], forkedFromConversationIds: null },
          ],
          activeInstanceId: 'a',
        },
      },
    ],
  } as unknown as PersistedTabState
}

let dir: string
let tabsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'split-rollback-'))
  tabsPath = join(dir, 'tabs.json')
  migrateMock.mockReset()
  atomicWriteMock.mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runTabSplitMigration — rollback safety (ADR-011)', () => {
  it('verify failure leaves the original file byte-identical and writes nothing', () => {
    const input = multiInstanceInput()
    const originalJson = JSON.stringify(input, null, 2)
    writeFileSync(tabsPath, originalJson, 'utf-8')

    // Transform returns output that still carries a multi-instance tab →
    // verifySplitMigration must reject it (single-instance invariant broken).
    migrateMock.mockReturnValue(input)

    const outcome = runTabSplitMigration(tabsPath)

    expect(outcome.migrated).toBe(false)
    expect(outcome.reason).toBe('verify-failed')
    // The runner must NOT have written migrated content.
    expect(atomicWriteMock).not.toHaveBeenCalled()
    // Original file is byte-identical.
    expect(readFileSync(tabsPath, 'utf-8')).toBe(originalJson)
    // Backup was taken and retained.
    expect(outcome.backupPath).toBeDefined()
    expect(readFileSync(outcome.backupPath!, 'utf-8')).toBe(originalJson)
  })

  it('restores from backup when the atomic write fails mid-flight', () => {
    const input = multiInstanceInput()
    const originalJson = JSON.stringify(input, null, 2)
    writeFileSync(tabsPath, originalJson, 'utf-8')

    // Transform produces a VALID single-instance split (passes verify)...
    migrateMock.mockReturnValue({
      schemaVersion: 3,
      activeSessionId: null,
      tabs: [
        { ...input.tabs![0], conversationPane: { instances: [(input.tabs![0] as any).conversationPane.instances[0]], activeInstanceId: 'a' }, conversationId: 'c-a' },
        { ...input.tabs![0], conversationPane: { instances: [(input.tabs![0] as any).conversationPane.instances[1]], activeInstanceId: 'b' }, conversationId: 'c-b' },
      ],
    })
    // ...but the atomic write corrupts the file and then throws mid-flight
    // (simulating a partial write: the on-disk content is damaged before the
    // failure surfaces). Only the catch-block restore can bring it back.
    atomicWriteMock.mockImplementation(() => {
      writeFileSync(tabsPath, '{ "corrupt": true, partial', 'utf-8')
      throw new Error('ENOSPC: no space left on device')
    })

    const outcome = runTabSplitMigration(tabsPath)

    expect(outcome.migrated).toBe(false)
    expect(outcome.reason).toBe('error')
    expect(atomicWriteMock).toHaveBeenCalledTimes(1)
    // The file must be restored from the backup, byte-identical to the input —
    // NOT left in the corrupted partial-write state.
    expect(readFileSync(tabsPath, 'utf-8')).toBe(originalJson)
    expect(outcome.backupPath).toBeDefined()
    expect(readFileSync(outcome.backupPath!, 'utf-8')).toBe(originalJson)
  })
})
