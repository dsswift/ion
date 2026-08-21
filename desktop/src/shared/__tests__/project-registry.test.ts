/**
 * Project registry (G1): normalize/sanitize, recency ordering with
 * basename disambiguation, auto-populate semantics (rate-limited bump,
 * identity short-circuit), manual add/remove round-trip.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeProjectDir,
  sanitizeProjectRegistry,
  orderedProjects,
  registerProjectUse,
  type ProjectRegistry,
} from '../project-registry'

describe('sanitizeProjectRegistry', () => {
  it('malformed disk → {}', () => {
    expect(sanitizeProjectRegistry(null)).toEqual({})
    expect(sanitizeProjectRegistry('junk')).toEqual({})
    expect(sanitizeProjectRegistry([])).toEqual({})
  })

  it('filters relative keys and non-object values; defaults fields', () => {
    const out = sanitizeProjectRegistry({
      '/a': { addedManually: true, lastUsedAt: 5, name: 'Alpha' },
      'rel': { addedManually: true, lastUsedAt: 5 },
      '/b': 'nope',
      '/c': { lastUsedAt: 'NaN' },
    })
    expect(out).toEqual({
      '/a': { addedManually: true, lastUsedAt: 5, name: 'Alpha' },
      '/c': { addedManually: false, lastUsedAt: 0 },
    })
  })
})

describe('orderedProjects', () => {
  it('orders by lastUsedAt desc and disambiguates duplicate basenames', () => {
    const registry: ProjectRegistry = {
      '/client-a/api': { addedManually: false, lastUsedAt: 100 },
      '/client-b/api': { addedManually: false, lastUsedAt: 300 },
      '/solo/web': { addedManually: false, lastUsedAt: 200 },
    }
    const out = orderedProjects(registry)
    expect(out.map((p) => p.dir)).toEqual(['/client-b/api', '/solo/web', '/client-a/api'])
    expect(out[0].displayName).toBe('api (client-b)')
    expect(out[2].displayName).toBe('api (client-a)')
    expect(out[1].displayName).toBe('web')
  })

  it('name override wins over basename', () => {
    const out = orderedProjects({ '/x/y': { name: 'My Project', addedManually: true, lastUsedAt: 1 } })
    expect(out[0].displayName).toBe('My Project')
  })
})

describe('registerProjectUse', () => {
  it('creates absent entries as auto-populated', () => {
    const next = registerProjectUse({}, '/repo/', 1000)
    expect(next).toEqual({ '/repo': { addedManually: false, lastUsedAt: 1000 } })
  })

  it('bumps recency but rate-limits to once per minute (identity short-circuit)', () => {
    const base: ProjectRegistry = { '/repo': { addedManually: true, lastUsedAt: 1000 } }
    // Within the window: SAME reference back (no settings churn at boot).
    expect(registerProjectUse(base, '/repo', 1000 + 30_000)).toBe(base)
    // Past the window: new object, bumped, manual flag preserved.
    const bumped = registerProjectUse(base, '/repo', 1000 + 120_000)
    expect(bumped).not.toBe(base)
    expect(bumped['/repo']).toEqual({ addedManually: true, lastUsedAt: 1000 + 120_000 })
  })

  it('relative dirs are refused (same reference)', () => {
    const base: ProjectRegistry = {}
    expect(registerProjectUse(base, 'not-absolute', 1)).toBe(base)
    expect(registerProjectUse(base, '~', 1)).toBe(base)
  })
})

describe('normalizeProjectDir', () => {
  it('strips trailing slashes, keeps root', () => {
    expect(normalizeProjectDir('/a/b//')).toBe('/a/b')
    expect(normalizeProjectDir('/')).toBe('/')
  })
})
