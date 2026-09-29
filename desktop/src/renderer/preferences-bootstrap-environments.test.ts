/**
 * preferences-bootstrap — managed environments wiring (spec 14): the
 * catalog reconciliation runs whenever `customFields['ion-desktop'].environments`
 * is present, and the environments managed-default marker records the
 * first application (mirroring the tab-strip/theme markers' shape).
 *
 * Source-scan style, matching the established convention for wiring pinned
 * inside `bootstrapPreferences` (see `preferences-bootstrap.ts`'s own
 * mixture of window.ion, localStorage, and store side effects, which makes
 * a full mount test's setup cost disproportionate to what this block does:
 * call reconcileManagedCatalog with the policy's environments array).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'preferences-bootstrap.ts'), 'utf8')

describe('preferences-bootstrap: managed environments (spec 14)', () => {
  it('reconciles the catalog from customFields[ion-desktop].environments', () => {
    expect(source).toContain("policy?.customFields?.['ion-desktop']");
    expect(source).toContain('reconcileManagedCatalog(targets)')
  })

  it('records the environments managed-default marker after reconciling', () => {
    expect(source).toContain("markManagedDefaultApplied('environments')")
  })

  it('a reconciliation failure is logged, not swallowed', () => {
    expect(source).toContain("rWarn('preferences', 'managed environments reconciliation failed'")
  })
})
