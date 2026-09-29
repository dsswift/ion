/**
 * Status-bar picker unification guards (#256 follow-up).
 *
 * The permission-mode / thinking / model pickers no longer fork on tab type:
 * they read the per-conversation value from the active instance (or the unified
 * effectivePermissionMode seam) for every tab, and the genuine product
 * difference (an extension-governed conversation) is expressed as a DATA
 * predicate, never a useActiveEngineKey / isEngine branch. These guards fail if
 * a picker re-introduces a tab-type read/write fork or the deleted setEngineModel
 * action reappears.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const COMPONENTS = resolve(__dirname, '..')
const SERVER_STORE = resolve(__dirname, '../../../../../server/src/store')
const SLICES = resolve(SERVER_STORE, 'slices')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('status-bar pickers are data-driven, not tab-type forks', () => {
  it('permission-mode picker reads via effectivePermissionMode and a governance flag', () => {
    const src = read(resolve(COMPONENTS, 'StatusBarPermissionModePicker.tsx'))
    // Read through the unified seam, not a useActiveEngineKey branch.
    expect(src).toContain('effectivePermissionMode')
    expect(src).not.toContain('useActiveEngineKey')
    // Governance is a named data predicate.
    expect(src).toContain('permissionModeGoverned')
    expect(src).not.toMatch(/const\s+isEngine\b/)
  })

  it('thinking picker reads effort from the active instance for every tab', () => {
    const src = read(resolve(COMPONENTS, 'StatusBarThinkingPicker.tsx'))
    expect(src).toContain('activeInstance(')
    expect(src).not.toContain('useActiveEngineKey')
    expect(src).not.toMatch(/const\s+isEngine\b/)
  })

  it('thinking effort is written to the active instance (no tab-type fork)', () => {
    const src = read(resolve(SLICES, 'tab-slice-thinking.ts'))
    expect(src).toContain('commitInstance')
    expect(src).not.toContain('tabHasExtensions')
  })

  it('model picker writes via setTabModel for every tab; setEngineModel is gone', () => {
    const src = read(resolve(COMPONENTS, 'StatusBarModelPicker.tsx'))
    expect(src).toContain('setTabModel')
    expect(src).not.toContain('useActiveEngineKey')
    expect(src).not.toMatch(/setEngineModel\(/)
  })

  it('setEngineModel action is removed from the engine slice and types', () => {
    const engineSlice = read(resolve(SLICES, 'engine-slice.ts'))
    expect(engineSlice).not.toMatch(/setEngineModel:/)
    const types = read(resolve(SERVER_STORE, 'session-store-types.ts'))
    expect(types).not.toMatch(/setEngineModel:/)
  })
})
