import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFileSync }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import {
  resolveEngineAddress,
  describeEngineAddress,
  looksLikeHostPort,
  supervisorHint,
  userScopedPort,
  connectToEngine,
  probeEngine,
  _resetPortCacheForTest,
} from '../engine-address'

/** whoami.exe /user /fo csv /nh output shape. */
const whoamiCsv = (sid: string) => `"joshuasprag1c6e\\josh","${sid}"\r\n`

beforeEach(() => {
  _resetPortCacheForTest()
  execFileSync.mockReset()
})

afterEach(() => {
  _resetPortCacheForTest()
})

describe('resolveEngineAddress', () => {
  it('defaults to a unix socket under ~/.ion on darwin', () => {
    const addr = resolveEngineAddress({}, 'darwin', '/Users/x')
    expect(addr).toEqual({ kind: 'unix', path: '/Users/x/.ion/engine.sock' })
  })

  it('respects ION_DATA_DIR on darwin', () => {
    const addr = resolveEngineAddress({ ION_DATA_DIR: '/custom/data' }, 'darwin', '/Users/x')
    expect(addr).toEqual({ kind: 'unix', path: '/custom/data/engine.sock' })
  })

  it('defaults to loopback TCP on a per-user port on win32', () => {
    execFileSync.mockReturnValue(whoamiCsv('S-1-5-21-1696802954-1770460993-270566097-1000'))
    const addr = resolveEngineAddress({}, 'win32', 'C:\\Users\\x')
    expect(addr).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 52700 })
  })

  it('ION_SOCKET_PATH as host:port resolves to tcp on any platform', () => {
    const addr = resolveEngineAddress({ ION_SOCKET_PATH: '127.0.0.1:9999' }, 'darwin', '/Users/x')
    expect(addr).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 9999 })
  })

  it('ION_SOCKET_PATH as a unix path resolves to unix', () => {
    const addr = resolveEngineAddress({ ION_SOCKET_PATH: '/tmp/x.sock' }, 'darwin', '/Users/x')
    expect(addr).toEqual({ kind: 'unix', path: '/tmp/x.sock' })
  })

  it('ION_SOCKET_PATH as a windows drive-letter path resolves to unix (drive letter is not host:port)', () => {
    const addr = resolveEngineAddress({ ION_SOCKET_PATH: 'C:\\Users\\x\\.ion\\engine.sock' }, 'win32', 'C:\\Users\\x')
    expect(addr).toEqual({ kind: 'unix', path: 'C:\\Users\\x\\.ion\\engine.sock' })
  })

  it('ION_SOCKET_PATH with a bracketed IPv6 host resolves host and port correctly', () => {
    const addr = resolveEngineAddress({ ION_SOCKET_PATH: '[::1]:21017' }, 'darwin', '/Users/x')
    expect(addr).toEqual({ kind: 'tcp', host: '[::1]', port: 21017 })
  })

  it('ION_SOCKET_PATH wins over the win32 default', () => {
    const addr = resolveEngineAddress({ ION_SOCKET_PATH: '/tmp/x.sock' }, 'win32', 'C:\\Users\\x')
    expect(addr).toEqual({ kind: 'unix', path: '/tmp/x.sock' })
  })
})

describe('looksLikeHostPort', () => {
  it('accepts host:port', () => expect(looksLikeHostPort('127.0.0.1:21017')).toBe(true))
  it('rejects a leading-slash path', () => expect(looksLikeHostPort('/tmp/x.sock')).toBe(false))
  it('rejects a dot-relative path', () => expect(looksLikeHostPort('./x.sock')).toBe(false))
  it('rejects a drive-letter path', () => expect(looksLikeHostPort('C:\\Users\\x')).toBe(false))
  it('rejects a string with no colon', () => expect(looksLikeHostPort('engine.sock')).toBe(false))
})

describe('describeEngineAddress', () => {
  it('renders a unix address', () => {
    expect(describeEngineAddress({ kind: 'unix', path: '/Users/x/.ion/engine.sock' })).toBe('unix:/Users/x/.ion/engine.sock')
  })
  it('renders a tcp address', () => {
    expect(describeEngineAddress({ kind: 'tcp', host: '127.0.0.1', port: 21017 })).toBe('tcp:127.0.0.1:21017')
  })
})

describe('supervisorHint', () => {
  it('darwin names launchctl', () => expect(supervisorHint('darwin')).toContain('launchctl'))
  it('linux names ion status', () => expect(supervisorHint('linux')).toBe('ion status'))

  // The hint is pasted into a shell by an operator who is already failing to
  // reach their engine. A command that cannot run is worse than no hint: it
  // reports "the system cannot find the file specified" and reads as
  // confirmation that the task is gone.
  it('win32 with a SID names that user\'s exact task', () => {
    const hint = supervisorHint('win32', 'S-1-5-21-99-1001')
    expect(hint).toBe('schtasks /Query /TN "Ion Engine (S-1-5-21-99-1001)" /V /FO LIST')
  })

  it('win32 without a SID falls back to an enumeration schtasks cannot express', () => {
    const hint = supervisorHint('win32', null)
    expect(hint).not.toContain('schtasks')
    expect(hint).toContain('Get-ScheduledTask')
    expect(hint).toContain("'Ion Engine*'")
  })

  // schtasks /TN takes an exact name; it has no wildcard syntax at all. The
  // previous hint passed `"Ion Engine (*"` and always failed.
  it('never emits a schtasks wildcard', () => {
    for (const sid of ['S-1-5-21-99-1001', null]) {
      expect(supervisorHint('win32', sid)).not.toContain('(*')
    }
  })
})

describe('userScopedPort', () => {
  // These vectors are asserted identically in engine/cmd/ion/port_test.go.
  // The desktop derives the engine's address independently rather than being
  // told it, so a divergence between the two derivations is a desktop that
  // cannot find its own engine. Pinning the same SID/port pairs on both sides
  // makes that divergence a test failure instead of a silent outage.
  it.each([
    ['S-1-5-21-1696802954-1770460993-270566097-1000', 52700],
    ['S-1-5-21-1696802954-1770460993-270566097-1001', 51784],
    ['S-1-5-18', 51925],
  ])('derives %s to port %i, matching the engine', (sid, port) => {
    execFileSync.mockReturnValue(whoamiCsv(sid as string))
    expect(userScopedPort()).toEqual({ port })
  })

  // The reason this exists: two accounts on one machine must never resolve to
  // the same address. A fixed port meant the second user's engine could not
  // bind and their desktop connected to the FIRST user's engine instead.
  it('gives two users on one machine different ports', () => {
    execFileSync.mockReturnValue(whoamiCsv('S-1-5-21-1696802954-1770460993-270566097-1000'))
    const a = userScopedPort()
    _resetPortCacheForTest()
    execFileSync.mockReturnValue(whoamiCsv('S-1-5-21-1696802954-1770460993-270566097-1001'))
    expect(userScopedPort()).not.toEqual(a)
  })

  it('stays inside the IANA dynamic port range', () => {
    execFileSync.mockReturnValue(whoamiCsv('S-1-5-21-9-9-9-1234'))
    const result = userScopedPort()
    if (!('port' in result)) throw new Error(`expected a port, got ${result.reason}`)
    expect(result.port).toBeGreaterThanOrEqual(49152)
    expect(result.port).toBeLessThanOrEqual(65535)
  })

  // The regression. This used to return the shared 21017, which meant two
  // users whose SID lookups both failed resolved to the SAME address and the
  // second desktop attached to the first user's engine. There is no fallback
  // port now: an unreadable SID yields a reason, and the address is reported
  // unavailable rather than guessed.
  it('reports a reason instead of falling back to a shared port', () => {
    execFileSync.mockImplementation(() => { throw new Error('whoami failed') })
    const result = userScopedPort()
    expect('port' in result).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/SID/)
  })

  it('resolves win32 to an unavailable address when the SID cannot be read', () => {
    execFileSync.mockImplementation(() => { throw new Error('whoami failed') })
    const addr = resolveEngineAddress({}, 'win32', 'C:\\Users\\x')
    expect(addr.kind).toBe('unavailable')
    expect(describeEngineAddress(addr)).toMatch(/^unavailable:/)
  })

  // An address that does not exist must not be turned into a connection to
  // one that does. Nothing may guess here.
  it('refuses to connect to an unavailable address', () => {
    expect(() => connectToEngine({ kind: 'unavailable', reason: 'no SID' })).toThrow(/No Ion Engine address/)
  })

  // The readiness poll asks "is it up yet". An unavailable address answers
  // no, so the caller's own budget ends the wait instead of an exception
  // escaping a poll loop.
  it('probes an unavailable address as unreachable rather than throwing', async () => {
    await expect(probeEngine({ kind: 'unavailable', reason: 'no SID' })).resolves.toBe(false)
  })

  // Consulted on every reconnect probe; the SID cannot change within a process.
  it('reads the SID once and caches it', () => {
    execFileSync.mockReturnValue(whoamiCsv('S-1-5-18'))
    userScopedPort()
    userScopedPort()
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })
})
