import { describe, expect, it } from 'vitest'
import { checkEngineVersion, meetsMinVersion } from '../version-check'

describe('checkEngineVersion', () => {
  it('reads the semver core out of a release tag as git describe prints it', () => {
    // The packaged engine reports its build tag, not a bare semver; every
    // boot logged it as unparseable.
    const check = checkEngineVersion('desktop-v1.100.1-257-g2271d2a91', '1.0.0')
    expect(check.ok).toBe(true)
    expect(checkEngineVersion('desktop-v1.100.1-257-g2271d2a91', '2.0.0')).toMatchObject({ ok: false, reason: 'engine_incompatible' })
  })

  it('still accepts a bare semver and still refuses a string with no version at all', () => {
    expect(checkEngineVersion('1.2.3', '1.2.0').ok).toBe(true)
    expect(checkEngineVersion('dev', '1.0.0')).toMatchObject({ ok: false, reason: 'unparseable_version' })
  })

  it('treats a minimum of 0.0.0 as no constraint, even for a dev engine with no semver', () => {
    // A dev engine reports dev-<commit>; with no minimum the server refused
    // readiness anyway.
    expect(checkEngineVersion('dev-d11ef7d05eeb', '0.0.0')).toMatchObject({ ok: true })
    expect(meetsMinVersion('dev-d11ef7d05eeb', '0.0.0')).toBe(true)
    expect(meetsMinVersion('dev-d11ef7d05eeb', '1.0.0')).toBe(false)
  })
})
