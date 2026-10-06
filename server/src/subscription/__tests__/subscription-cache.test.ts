import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../utils/secretStore', () => ({
  encryptForDisk: (plain: string) => `enc:${Buffer.from(plain).toString('base64')}`,
  decryptFromDisk: (value: string) => Buffer.from(value.replace(/^enc:/, ''), 'base64').toString(),
}))

import { FileSubscriptionCache } from '../subscription-cache'

let dir: string
let cache: FileSubscriptionCache
const ENTRY = { selectedId: 'sub-high', label: 'High quota', key: 'secret-key-value', options: [{ id: 'sub-high', label: 'High quota' }], resolvedAt: 42 }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-sub-cache-')); cache = new FileSubscriptionCache(() => dir) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('FileSubscriptionCache', () => {
  it('remembers a person\'s subscription across restarts', () => {
    cache.save('alice', 'gateway', ENTRY)
    expect(new FileSubscriptionCache(() => dir).load('alice', 'gateway')).toEqual(ENTRY)
  })

  it('never writes the key in the clear, and keeps the file private', () => {
    cache.save('alice', 'gateway', ENTRY)
    const path = join(dir, 'subscription-lookup.json')
    expect(readFileSync(path, 'utf-8')).not.toContain('secret-key-value')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('keeps one person\'s entry apart from another\'s', () => {
    cache.save('alice', 'gateway', ENTRY)
    cache.save('bob', 'gateway', { ...ENTRY, selectedId: 'sub-std', key: 'bob-key' })
    expect(cache.load('alice', 'gateway')?.key).toBe('secret-key-value')
    expect(cache.load('bob', 'gateway')?.key).toBe('bob-key')
    expect(cache.load('carol', 'gateway')).toBeNull()
    expect(cache.load('alice', 'other-provider')).toBeNull()
  })

  it('replaces a person\'s entry rather than adding a second', () => {
    cache.save('alice', 'gateway', ENTRY)
    cache.save('alice', 'gateway', { ...ENTRY, selectedId: 'sub-std' })
    const stored = JSON.parse(readFileSync(join(dir, 'subscription-lookup.json'), 'utf-8')) as { entries: unknown[] }
    expect(stored.entries).toHaveLength(1)
    expect(cache.load('alice', 'gateway')?.selectedId).toBe('sub-std')
  })

  it('clears only the named person and provider', () => {
    cache.save('alice', 'gateway', ENTRY)
    cache.save('bob', 'gateway', ENTRY)
    cache.clear('alice', 'gateway')
    expect(cache.load('alice', 'gateway')).toBeNull()
    expect(cache.load('bob', 'gateway')).not.toBeNull()
  })

  it('starts empty from a missing or unreadable file', () => {
    expect(cache.load('alice', 'gateway')).toBeNull()
    cache.save('alice', 'gateway', ENTRY)
    // Corrupt the file: the cache must not throw, only forget.
    writeFileSync(join(dir, 'subscription-lookup.json'), '{ not json')
    expect(cache.load('alice', 'gateway')).toBeNull()
  })
})
