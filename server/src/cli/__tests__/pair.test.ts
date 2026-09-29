import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Pins the headless pairing CLI against a REAL booted server (the engine
 * bridge mocked exactly as `__tests__/boot.test.ts` does): the CLI dials
 * the local `studio.sock`, is welcomed through the `local` door with every
 * scope, and receives a link that carries the server's advertised URL.
 */
const bridge = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.resolve()),
  connected: true,
  request: vi.fn(() => Promise.resolve({ ok: true, data: { home: '/tmp', username: 'test', hostname: 'test-host', os: 'darwin', pathSep: '/' } })),
  on: vi.fn(),
}))
vi.mock('../../state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state')>()
  return { ...actual, engineBridge: bridge }
})

import { main } from '../../main'
import { mintPairingLink, parsePairArgs } from '../pair'
import type { ServerHandle } from '../../main'

let tmp: string
let originalIonDataDir: string | undefined
let handle: ServerHandle | null = null

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  tmp = mkdtempSync(join(tmpdir(), 'ion-pair-cli-'))
  process.env.ION_DATA_DIR = tmp
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(tmp, { recursive: true, force: true })
})

describe('parsePairArgs', () => {
  it('defaults label, scopes, and output mode', () => {
    const parsed = parsePairArgs([])
    expect(parsed).toMatchObject({ ok: true, options: { label: 'paired client', scopes: undefined, json: false } })
  })

  it('accepts label, scopes, and json', () => {
    const parsed = parsePairArgs(['--label', 'my laptop', '--scopes', 'conversations:read,admin', '--json'])
    expect(parsed).toMatchObject({ ok: true, options: { label: 'my laptop', scopes: ['conversations:read', 'admin'], json: true } })
  })

  it('accepts --as, the person the joining device belongs to', () => {
    expect(parsePairArgs(['--as', 'bob'])).toMatchObject({ ok: true, options: { as: 'bob' } })
    expect(parsePairArgs(['--as'])).toMatchObject({ ok: false })
  })

  it('refuses an unknown scope and an unknown flag', () => {
    expect(parsePairArgs(['--scopes', 'nope'])).toMatchObject({ ok: false })
    expect(parsePairArgs(['--bogus'])).toMatchObject({ ok: false })
  })
})

describe('mintPairingLink against a booted server', () => {
  it('is welcomed over the local socket and receives a link naming the advertised url', async () => {
    writeFileSync(join(tmp, 'server.json'), JSON.stringify({
      label: 'Test Lab',
      listen: { tcp: { port: 0 } },
      pairing: { advertiseUrl: 'http://lab.example.org:7331' },
    }))
    handle = await main()

    const result = await mintPairingLink({ kind: 'unix', path: join(tmp, 'studio.sock') }, { label: 'laptop', scopes: undefined, json: false, relay: false, timeoutMs: 5000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const link = new URL(result.url)
    expect(link.protocol).toBe('ion-studio:')
    expect(link.searchParams.get('code')).toBe(result.code)
    expect(link.searchParams.get('url')).toBe('http://lab.example.org:7331')
    expect(link.searchParams.get('env')).toBe('Test Lab')
    expect(result.environmentLabel).toBe('Test Lab')
    expect(result.environmentId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('reports an unreachable socket instead of hanging', async () => {
    const result = await mintPairingLink({ kind: 'unix', path: join(tmp, 'missing.sock') }, { label: 'x', scopes: undefined, json: false, relay: false, timeoutMs: 2000 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('cannot reach the server')
  })
})
