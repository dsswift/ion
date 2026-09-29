/**
 * Tests for shouldStreamThinkingToRemote + cache invalidation (issue #158).
 *
 * The setting gates whether the desktop forwards `engine_thinking_delta`
 * events to paired iOS devices (low-bandwidth mode facet 1). Because the
 * gate is read on the hot iOS forward path, the resolved boolean is cached
 * and invalidated on every settings write. These tests pin:
 *
 *   1. Default ON when the key is absent (matches SETTINGS_DEFAULTS).
 *   2. Honors an explicit `false`; treats any non-false as ON.
 *   3. Caches across reads (only one disk read until invalidated).
 *   4. `writeSettings` invalidates the cache so a toggle change takes effect.
 *
 * Mocks fs at the boundary (same pattern as settings-store-git-watcher).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('{}'),
  // atomicWriteFileSync (used by writeSettings) needs these fd primitives.
  openSync: vi.fn().mockReturnValue(3),
  writeSync: vi.fn(),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('fs', () => fsMock)

import {
  shouldStreamThinkingToRemote,
  invalidateStreamThinkingToRemoteCache,
  writeSettings,
} from '../settings-store'

function onDisk(obj: Record<string, unknown>): void {
  fsMock.readFileSync.mockReturnValue(JSON.stringify(obj))
}

describe('shouldStreamThinkingToRemote', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readFileSync.mockReturnValue('{}')
    fsMock.readFileSync.mockClear()
    invalidateStreamThinkingToRemoteCache()
  })

  it('defaults to true (stream ON) when the key is absent', () => {
    onDisk({})
    expect(shouldStreamThinkingToRemote()).toBe(true)
  })

  it('returns false when the key is explicitly false (stream OFF)', () => {
    onDisk({ streamThinkingToRemote: false })
    expect(shouldStreamThinkingToRemote()).toBe(false)
  })

  it('returns true when the key is explicitly true', () => {
    onDisk({ streamThinkingToRemote: true })
    expect(shouldStreamThinkingToRemote()).toBe(true)
  })

  it('treats a non-false, non-true value as ON (default-on semantics)', () => {
    // Only an explicit `false` disables. Anything else (a stray string,
    // a missing key) keeps the phone receiving the reasoning stream.
    onDisk({ streamThinkingToRemote: 'nonsense' })
    expect(shouldStreamThinkingToRemote()).toBe(true)
  })

  it('caches the resolved value — only one disk read until invalidated', () => {
    onDisk({ streamThinkingToRemote: false })
    expect(shouldStreamThinkingToRemote()).toBe(false)
    const readsAfterFirst = fsMock.readFileSync.mock.calls.length
    // Subsequent reads hit the cache, not the disk.
    shouldStreamThinkingToRemote()
    shouldStreamThinkingToRemote()
    expect(fsMock.readFileSync.mock.calls.length).toBe(readsAfterFirst)
  })

  it('invalidateStreamThinkingToRemoteCache forces a re-read', () => {
    onDisk({ streamThinkingToRemote: false })
    expect(shouldStreamThinkingToRemote()).toBe(false)
    // The user flips the toggle on disk; without invalidation the cache
    // would still report false.
    onDisk({ streamThinkingToRemote: true })
    expect(shouldStreamThinkingToRemote()).toBe(false) // still cached
    invalidateStreamThinkingToRemoteCache()
    expect(shouldStreamThinkingToRemote()).toBe(true) // re-read picks up the flip
  })

  it('writeSettings invalidates the cache (single write funnel)', () => {
    onDisk({ streamThinkingToRemote: true })
    expect(shouldStreamThinkingToRemote()).toBe(true)
    // A settings write flips the value; writeSettings must clear the cache
    // so the next gate read reflects the new on-disk truth.
    onDisk({ streamThinkingToRemote: false })
    writeSettings({ streamThinkingToRemote: false })
    expect(shouldStreamThinkingToRemote()).toBe(false)
  })
})
