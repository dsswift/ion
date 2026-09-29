/**
 * The phone carries its own copy of the automation catalog (it has no
 * TypeScript runtime). This snapshot is the one both sides are held to: this
 * test fails when the catalog changes without it, and the iOS
 * `AutomationCatalogTests` fails when the Swift copy differs from it.
 * Refresh with `UPDATE_AUTOMATION_CATALOG=1 npx vitest run automation-catalog-snapshot`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from '../automation-catalog'

const SNAPSHOT = join(__dirname, 'fixtures', 'automation-catalog.json')

describe('automation catalog snapshot', () => {
  it('matches the snapshot the phone is tested against', () => {
    const current = `${JSON.stringify({ triggers: AUTOMATION_TRIGGERS, actions: AUTOMATION_ACTIONS }, null, 2)}\n`
    if (process.env.UPDATE_AUTOMATION_CATALOG === '1') writeFileSync(SNAPSHOT, current)
    expect(readFileSync(SNAPSHOT, 'utf8')).toBe(current)
  })
})
