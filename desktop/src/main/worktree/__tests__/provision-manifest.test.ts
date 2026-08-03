/**
 * Provisioning manifest reader.
 *
 * The contract that matters most is the FAIL-OPEN one: no manifest, a malformed
 * manifest, or an unsupported version must all yield an empty plan rather than a
 * throw. Provisioning is strictly additive, so a repo that has never heard of it
 * — or one with a typo in its JSON — must still create worktrees exactly as it
 * did before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { readBenchVerify, readProvisionManifest } from '../provision-manifest'

let repo: string

function writeManifest(content: string): void {
  mkdirSync(join(repo, '.ion'), { recursive: true })
  writeFileSync(join(repo, '.ion', 'worktree.json'), content)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ion-manifest-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('readProvisionManifest — the happy path', () => {
  it('parses seed entries and setup', () => {
    writeManifest(JSON.stringify({
      version: 1,
      worktree: {
        seed: [
          { path: 'node_modules', build: 'npm ci', staleWhen: ['package-lock.json'] },
          { path: 'desktop/node_modules', build: 'npm ci', cwd: 'desktop' },
        ],
        setup: 'make bootstrap',
      },
    }))

    const plan = readProvisionManifest(repo)

    expect(plan.seed).toHaveLength(2)
    expect(plan.seed[0]).toEqual({
      path: 'node_modules', build: 'npm ci', cwd: undefined, staleWhen: ['package-lock.json'],
    })
    expect(plan.seed[1].cwd).toBe('desktop')
    expect(plan.setup).toBe('make bootstrap')
  })

  it('accepts a seed entry with no build command (copy-only)', () => {
    writeManifest(JSON.stringify({ version: 1, worktree: { seed: [{ path: 'vendor' }] } }))
    const plan = readProvisionManifest(repo)
    expect(plan.seed[0]).toMatchObject({ path: 'vendor', build: undefined })
  })
})

describe('readProvisionManifest — fails open, never throws', () => {
  it('returns an empty plan when no manifest exists', () => {
    expect(readProvisionManifest(repo)).toEqual({ seed: [] })
  })

  it('returns an empty plan for malformed JSON', () => {
    writeManifest('{ not json')
    expect(readProvisionManifest(repo)).toEqual({ seed: [] })
  })

  it('returns an empty plan for an unsupported version', () => {
    writeManifest(JSON.stringify({ version: 99, worktree: { seed: [{ path: 'node_modules' }] } }))
    expect(readProvisionManifest(repo)).toEqual({ seed: [] })
  })

  it('returns an empty plan when the worktree block is missing', () => {
    writeManifest(JSON.stringify({ version: 1 }))
    expect(readProvisionManifest(repo)).toEqual({ seed: [] })
  })

  it('ignores a non-array seed without discarding setup', () => {
    writeManifest(JSON.stringify({ version: 1, worktree: { seed: 'nope', setup: 'make bootstrap' } }))
    const plan = readProvisionManifest(repo)
    expect(plan.seed).toEqual([])
    expect(plan.setup).toBe('make bootstrap')
  })
})

describe('readBenchVerify', () => {
  it('parses command and timeout', () => {
    writeManifest(JSON.stringify({
      version: 1,
      bench: { verify: 'npm test', verifyTimeoutMs: 1234 },
    }))
    expect(readBenchVerify(repo)).toEqual({ verify: 'npm test', verifyTimeoutMs: 1234 })
  })

  it('returns undefined when block is missing', () => {
    writeManifest(JSON.stringify({ version: 1, worktree: { seed: [] } }))
    expect(readBenchVerify(repo)).toBeUndefined()
  })

  it('returns undefined for non-string command', () => {
    writeManifest(JSON.stringify({ version: 1, bench: { verify: true } }))
    expect(readBenchVerify(repo)).toBeUndefined()
  })

  it('returns undefined for malformed JSON without throwing', () => {
    writeManifest('{ broken')
    expect(readBenchVerify(repo)).toBeUndefined()
  })
})

describe('readProvisionManifest — path containment', () => {
  // Seeding must only ever write inside the destination worktree. A `..` or an
  // absolute path in the manifest is the one way data could subvert that, so it
  // is rejected at read time rather than trusted downstream.
  it('rejects an absolute seed path', () => {
    writeManifest(JSON.stringify({ version: 1, worktree: { seed: [{ path: '/etc' }] } }))
    expect(readProvisionManifest(repo).seed).toEqual([])
  })

  it('rejects a seed path escaping the repo', () => {
    writeManifest(JSON.stringify({ version: 1, worktree: { seed: [{ path: '../elsewhere' }] } }))
    expect(readProvisionManifest(repo).seed).toEqual([])
  })

  it('rejects a Windows drive-qualified seed path', () => {
    writeManifest(JSON.stringify({ version: 1, worktree: { seed: [{ path: 'C:\\Windows' }] } }))
    expect(readProvisionManifest(repo).seed).toEqual([])
  })

  it('rejects an entry whose cwd escapes the repo', () => {
    writeManifest(JSON.stringify({
      version: 1, worktree: { seed: [{ path: 'node_modules', cwd: '../..' }] },
    }))
    expect(readProvisionManifest(repo).seed).toEqual([])
  })

  it('drops a bad entry without discarding the good ones', () => {
    writeManifest(JSON.stringify({
      version: 1,
      worktree: { seed: [{ path: '../bad' }, { path: 'node_modules', build: 'npm ci' }] },
    }))
    const plan = readProvisionManifest(repo)
    expect(plan.seed).toHaveLength(1)
    expect(plan.seed[0].path).toBe('node_modules')
  })

  it('filters escaping staleWhen entries but keeps the entry', () => {
    writeManifest(JSON.stringify({
      version: 1,
      worktree: { seed: [{ path: 'node_modules', staleWhen: ['../x', 'package-lock.json'] }] },
    }))
    expect(readProvisionManifest(repo).seed[0].staleWhen).toEqual(['package-lock.json'])
  })
})
