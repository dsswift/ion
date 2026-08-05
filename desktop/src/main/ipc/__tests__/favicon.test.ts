import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the registered handler instead of going through real IPC.
let handler: ((evt: unknown, host: unknown) => Promise<string | null>) | null = null
vi.mock('electron', () => ({
  ipcMain: {
    handle: (_channel: string, fn: typeof handler) => { handler = fn },
  },
}))

const debugSpy = vi.fn()
vi.mock('../../logger', () => ({
  debug: (...args: unknown[]) => debugSpy(...args),
}))

// Keep the disk cache out of the tests: statSync misses (ENOENT) and writes
// are directed at a temp dir via HOME below is not possible (homedir is read
// at module load), so stub fs instead.
const statSync = vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
const readFileSync = vi.fn()
const writeFileSync = vi.fn()
const mkdirSync = vi.fn()
vi.mock('fs', () => ({
  statSync: (...args: unknown[]) => statSync(...(args as [])),
  readFileSync: (...args: unknown[]) => readFileSync(...(args as [])),
  writeFileSync: (...args: unknown[]) => writeFileSync(...(args as [])),
  mkdirSync: (...args: unknown[]) => mkdirSync(...(args as [])),
}))

import { registerFaviconIpc, __resetFaviconCacheForTests } from '../favicon'
import { isValidFaviconHost } from '../../ipc-validation'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  registerFaviconIpc()
})

afterEach(() => {
  __resetFaviconCacheForTests()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  debugSpy.mockClear()
  writeFileSync.mockClear()
})

function okResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as Response
}

describe('isValidFaviconHost', () => {
  it('accepts real hostnames and rejects URL-ish input', () => {
    expect(isValidFaviconHost('example.com')).toBe(true)
    expect(isValidFaviconHost('sub.example-site.co.uk')).toBe(true)
    expect(isValidFaviconHost('https://example.com')).toBe(false)
    expect(isValidFaviconHost('example.com/path')).toBe(false)
    expect(isValidFaviconHost('a&b.com')).toBe(false)
    expect(isValidFaviconHost('')).toBe(false)
    expect(isValidFaviconHost('x'.repeat(260))).toBe(false)
  })
})

describe('favicon IPC handler', () => {
  it('fetches once and serves the memory cache afterwards', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('PNG')))
    const first = await handler!({}, 'example.com')
    const second = await handler!({}, 'example.com')
    expect(first).toMatch(/^data:image\/png;base64,/)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(writeFileSync).toHaveBeenCalledTimes(1) // disk cache populated
  })

  it('returns null on fetch failure, logs at debug, and caches the miss', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await handler!({}, 'down.example')).toBeNull()
    expect(debugSpy).toHaveBeenCalled()
    expect(await handler!({}, 'down.example')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1) // negative result cached
  })

  it('returns null for non-ok responses', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } })
    expect(await handler!({}, 'missing.example')).toBeNull()
  })

  it('rejects invalid hosts without fetching', async () => {
    expect(await handler!({}, 'https://evil.example/steal')).toBeNull()
    expect(await handler!({}, 42)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
