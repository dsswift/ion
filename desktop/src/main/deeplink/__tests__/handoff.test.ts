/**
 * Tests for the handoff-file transport.
 *
 * The refusals are the point. A handoff file is claimed to have been written by
 * a local process moments ago, and each check below is what makes that claim
 * mean something:
 *
 *   - deleted on read, so a request cannot be replayed by a second click,
 *   - deleted even when invalid, so a bad write cannot occupy the directory,
 *   - stale files refused, so an old crashed run does not fire later,
 *   - permissive files refused, so "under my home" is not weaker than it looks,
 *   - oversized files refused before being read into memory,
 *   - a non-UUID id refused even here, because this function interpolates it
 *     into a path and must not trust that the parser already checked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, chmodSync, utimesSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let fakeHome: string

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})

vi.mock('../../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

const VALID_ID = '123e4567-e89b-12d3-a456-426614174000'

function handoffPath(id = VALID_ID): string {
  return join(fakeHome, '.ion', 'deeplink-requests', `${id}.json`)
}

/** Write a handoff file with 0600 and a fresh mtime. */
function writeHandoff(body: unknown, id = VALID_ID): string {
  const p = handoffPath(id)
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 })
  chmodSync(p, 0o600)
  return p
}

describe('consumeHandoff', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ion-handoff-test-'))
    mkdirSync(join(fakeHome, '.ion', 'deeplink-requests'), { recursive: true })
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('reads a valid payload and its token', async () => {
    writeHandoff({ action: 'prompt', dir: '/repo', text: 'hello', token: 'tok' })
    const { consumeHandoff } = await import('../handoff')

    const r = consumeHandoff(VALID_ID)

    expect(r.kind).toBe('ok')
    expect(r.kind === 'ok' && r.payload).toEqual({
      action: 'prompt', dir: '/repo', text: 'hello', submit: true,
    })
    expect(r.kind === 'ok' && r.token).toBe('tok')
  })

  it('deletes the file after a successful read (no replay)', async () => {
    const p = writeHandoff({ action: 'prompt', dir: '/repo', text: 'hi' })
    const { consumeHandoff } = await import('../handoff')

    consumeHandoff(VALID_ID)

    expect(existsSync(p)).toBe(false)
    // A second attempt finds nothing rather than firing again.
    expect(consumeHandoff(VALID_ID).kind).toBe('error')
  })

  it('deletes the file even when its payload is invalid', async () => {
    const p = writeHandoff({ action: 'nonsense' })
    const { consumeHandoff } = await import('../handoff')

    expect(consumeHandoff(VALID_ID).kind).toBe('error')
    expect(existsSync(p)).toBe(false)
  })

  it('deletes the file even when its json is malformed', async () => {
    const p = writeHandoff('{ not json')
    const { consumeHandoff } = await import('../handoff')

    expect(consumeHandoff(VALID_ID).kind).toBe('error')
    expect(existsSync(p)).toBe(false)
  })

  it('refuses a stale file', async () => {
    const p = writeHandoff({ action: 'prompt', dir: '/repo', text: 'old' })
    // Backdate well beyond the TTL.
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(p, old, old)
    const { consumeHandoff } = await import('../handoff')

    const r = consumeHandoff(VALID_ID)

    expect(r.kind).toBe('error')
    expect(r.kind === 'error' && r.reason).toContain('stale')
    expect(existsSync(p)).toBe(false)
  })

  it('refuses a group/world-accessible file', async () => {
    const p = writeHandoff({ action: 'prompt', dir: '/repo', text: 'hi' })
    chmodSync(p, 0o644)
    const { consumeHandoff } = await import('../handoff')

    const r = consumeHandoff(VALID_ID)

    expect(r.kind).toBe('error')
    expect(r.kind === 'error' && r.reason).toContain('not private')
    expect(existsSync(p)).toBe(false)
  })

  it('refuses an oversized file', async () => {
    const { HANDOFF_MAX_BYTES } = await import('../handoff')
    const p = writeHandoff('x'.repeat(HANDOFF_MAX_BYTES + 10))
    const { consumeHandoff } = await import('../handoff')

    const r = consumeHandoff(VALID_ID)

    expect(r.kind).toBe('error')
    expect(r.kind === 'error' && r.reason).toContain('too large')
    expect(existsSync(p)).toBe(false)
  })

  it('refuses a non-uuid id without touching the filesystem', async () => {
    const { consumeHandoff } = await import('../handoff')

    // Re-checked here even though the parser also checks: this function is what
    // builds the path.
    const r = consumeHandoff('../../../../etc/passwd')

    expect(r).toEqual({ kind: 'error', reason: 'handoff id is not a uuid' })
  })

  it('refuses an overlong token before dispatch can compare it', async () => {
    writeHandoff({ action: 'prompt', dir: '/repo', text: 'hi', token: 'x'.repeat(257) })
    const { consumeHandoff } = await import('../handoff')

    expect(consumeHandoff(VALID_ID)).toEqual({ kind: 'error', reason: 'handoff token rejected' })
  })

  it('reports a missing file as an error rather than throwing', async () => {
    const { consumeHandoff } = await import('../handoff')

    expect(consumeHandoff(VALID_ID)).toEqual({ kind: 'error', reason: 'handoff file not found' })
  })

  it('carries multi-line prompt text, the transport\'s reason for existing', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i}`).join('\n\n')
    writeHandoff({ action: 'prompt', dir: '/repo', text: long })
    const { consumeHandoff } = await import('../handoff')

    const r = consumeHandoff(VALID_ID)

    expect(r.kind === 'ok' && (r.payload as { text: string }).text).toBe(long)
  })
})

describe('ensureHandoffDir', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ion-handoff-dir-'))
    mkdirSync(join(fakeHome, '.ion'), { recursive: true })
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('creates the directory 0700 so only this user can drop requests', async () => {
    const { ensureHandoffDir, HANDOFF_DIR } = await import('../handoff')

    ensureHandoffDir()

    expect(existsSync(HANDOFF_DIR)).toBe(true)
    expect(statSync(HANDOFF_DIR).mode & 0o777).toBe(0o700)
  })

  it('is idempotent', async () => {
    const { ensureHandoffDir } = await import('../handoff')

    ensureHandoffDir()
    expect(() => ensureHandoffDir()).not.toThrow()
  })
})
