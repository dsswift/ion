/** draft-lock — the central-only refusal of a local draft (spec 14). */
import { describe, expect, it } from 'vitest'
import { refusalForDraftEnvironment } from '../draft-lock'

describe('draft-lock', () => {
  it('refuses a local draft under central-only policy', () => {
    const refusal = refusalForDraftEnvironment('local', { mode: 'central-only', allowed: [], locked: false })
    expect(refusal).toMatch(/policy_disallowed/)
  })

  it('allows a local draft under every other policy mode', () => {
    expect(refusalForDraftEnvironment('local', { mode: 'allowlist', allowed: [], locked: true })).toBeNull()
    expect(refusalForDraftEnvironment('local', { mode: 'local-only', allowed: [], locked: false })).toBeNull()
  })

  it('never refuses a non-local draft based on central-only (that mode only concerns local)', () => {
    expect(refusalForDraftEnvironment('env-b', { mode: 'central-only', allowed: [], locked: false })).toBeNull()
  })
})
