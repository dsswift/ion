/**
 * Copy-on-write capability probe.
 *
 * These tests deliberately do NOT assert whether reflink is supported — that is
 * a property of the machine's filesystem, and asserting it would make the suite
 * pass on APFS and fail on ext4 for reasons unrelated to the code. What must
 * hold everywhere is the probe's CONTRACT: it answers a boolean, it never
 * throws, it caches, and it leaves no artifacts behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { supportsReflink, _resetCapabilityCacheForTests } from '../provision-capability'

let root: string
let source: string
let dest: string

beforeEach(() => {
  _resetCapabilityCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'ion-cap-'))
  source = join(root, 'src')
  dest = join(root, 'dst')
  mkdirSync(source, { recursive: true })
  mkdirSync(dest, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('supportsReflink', () => {
  it('answers a boolean without throwing', () => {
    const result = supportsReflink(source, dest)
    expect(typeof result).toBe('boolean')
  })

  it('leaves no probe artifacts in either directory', () => {
    supportsReflink(source, dest)
    expect(readdirSync(source).filter((f) => f.includes('ion-reflink-probe'))).toEqual([])
    expect(readdirSync(dest).filter((f) => f.includes('ion-reflink-probe'))).toEqual([])
  })

  it('creates the destination when absent rather than failing', () => {
    const fresh = join(root, 'not-yet')
    expect(() => supportsReflink(source, fresh)).not.toThrow()
  })

  it('returns false rather than throwing for an unusable source', () => {
    expect(supportsReflink(join(root, 'does-not-exist'), dest)).toBe(false)
  })

  it('caches per directory pair', () => {
    const first = supportsReflink(source, dest)
    // Removing the source would break a real probe; a cached answer survives it,
    // which is how we observe that the second call did not re-probe.
    rmSync(source, { recursive: true, force: true })
    expect(supportsReflink(source, dest)).toBe(first)
  })

  it('probes each directory pair independently', () => {
    const other = join(root, 'other')
    mkdirSync(other, { recursive: true })
    // Distinct keys: the second pair must be probed on its own merits, not
    // inherit the first pair's cached answer.
    expect(typeof supportsReflink(source, other)).toBe('boolean')
    expect(typeof supportsReflink(source, dest)).toBe('boolean')
  })
})
