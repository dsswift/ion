// @vitest-environment node
// Read-only smoke test against the operator's REAL tabs-api.json when present.
// Skipped in CI / on machines without the file. Proves the migration + verify
// pipeline handles real production data. NEVER writes to the real file — copies
// to a temp dir first.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { runTabUnifyMigration, verifyUnifyMigration } from '../tab-migration-unify-runner'
import { UNIFIED_SCHEMA_VERSION } from '../tab-migration-unify'

const REAL = join(homedir(), '.ion', 'tabs-api.json')

describe.skipIf(!existsSync(REAL))('REAL tabs-api.json migration smoke (read-only)', () => {
  it('migrates and verifies the real file in a temp copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-real-'))
    try {
      const tmp = join(dir, 'tabs.json')
      copyFileSync(REAL, tmp)
      const legacy = JSON.parse(readFileSync(tmp, 'utf-8'))
      const outcome = runTabUnifyMigration(tmp)
      expect(outcome.reason === 'success' || outcome.reason === 'already-unified').toBe(true)
      if (outcome.reason === 'success') {
        const written = JSON.parse(readFileSync(tmp, 'utf-8'))
        expect(written.schemaVersion).toBe(UNIFIED_SCHEMA_VERSION)
        expect(verifyUnifyMigration(legacy, written)).toBeNull()
        // every non-terminal tab got a pane
        for (const t of written.tabs) {
          if (t.isTerminalOnly) continue
          expect(t.conversationPane?.instances?.length ?? 0).toBeGreaterThan(0)
        }
        console.log(`[real-smoke] migrated ${written.tabs.length} real tabs, verify OK`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
