/**
 * Pins the Claude-compat default: `.claude` roots (commands, skills,
 * CLAUDE.md context) load ONLY when the user explicitly enables
 * enableClaudeCompat. `.ion` directories are the product's defaults and are
 * always active; compat is a migration feature, not a default. An absent or
 * malformed key must therefore resolve to false.
 *
 * Mocks fs at the boundary (same pattern as settings-store-thinking-stream).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('{}'),
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

vi.mock('fs', () => ({ default: fsMock, ...fsMock }))

import { readClaudeCompat, SETTINGS_DEFAULTS } from '../settings-store'

describe('readClaudeCompat default', () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReturnValue('{}')
  })

  it('SETTINGS_DEFAULTS carries compat OFF (greenfield installs are .ion-only)', () => {
    expect(SETTINGS_DEFAULTS.enableClaudeCompat).toBe(false)
  })

  it('resolves false when the key is absent', () => {
    expect(readClaudeCompat()).toBe(false)
  })

  it('resolves false when the key is not a boolean', () => {
    fsMock.readFileSync.mockReturnValue('{"enableClaudeCompat":"yes"}')
    expect(readClaudeCompat()).toBe(false)
  })

  it('honors an explicit true (migration opt-in)', () => {
    fsMock.readFileSync.mockReturnValue('{"enableClaudeCompat":true}')
    expect(readClaudeCompat()).toBe(true)
  })

  it('honors an explicit false', () => {
    fsMock.readFileSync.mockReturnValue('{"enableClaudeCompat":false}')
    expect(readClaudeCompat()).toBe(false)
  })
})
