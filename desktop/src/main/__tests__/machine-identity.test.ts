import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process.execFile so no subprocesses run in tests.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

// Mock logger to avoid file I/O.
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}))

import { execFile } from 'child_process'

const IOREG_STDOUT = `
+-o Root  <class IORegistryEntry, id 0x100000000, retain 18>
+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice, id 0x100000001, retain 21>
  "IOPlatformUUID" = "AABBCCDD-1122-3344-5566-778899AABBCC"
  "IOPlatformSerialNumber" = "XYZABC123456"
`

const MDM_PLIST_JSON = JSON.stringify({
  MDMDeviceID: 'intune-device-abc',
  MDMSerialNumber: 'SER123456',
})

// execFile calls are promisified inside machine-identity.ts; we mock the
// underlying execFile with a callback-style stub that the promisify wrapper
// will call correctly.
function makeExecFileMock(ioregStdout: string, mdmStdout: string, mdmError?: Error) {
  return vi.fn(
    (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string }) => void,
    ) => {
      if (file === 'ioreg') {
        cb(null, { stdout: ioregStdout })
      } else if (file === 'plutil') {
        if (mdmError) {
          cb(mdmError, { stdout: '' })
        } else {
          cb(null, { stdout: mdmStdout })
        }
      } else {
        cb(new Error(`unexpected command: ${file}`), { stdout: '' })
      }
    },
  )
}

describe('loadMachineIdentity', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset the cached identity between tests.
    const mod = await import('../machine-identity')
    mod._resetMachineIdentityForTest()
  })

  it('parses IOPlatformUUID and serial from ioreg output', async () => {
    ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      makeExecFileMock(IOREG_STDOUT, MDM_PLIST_JSON),
    )
    const { loadMachineIdentity } = await import('../machine-identity')
    // Override platform to darwin for this test.
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(id.machineId).toBe('AABBCCDD-1122-3344-5566-778899AABBCC')
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('populates MDM fields when plist is present', async () => {
    ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      makeExecFileMock(IOREG_STDOUT, MDM_PLIST_JSON),
    )
    const { loadMachineIdentity, _resetMachineIdentityForTest } = await import('../machine-identity')
    _resetMachineIdentityForTest()
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(id.mdmDeviceId).toBe('intune-device-abc')
      expect(id.mdmSerial).toBe('SER123456')
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('returns empty MDM fields when plist is missing (plutil error)', async () => {
    ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      makeExecFileMock(IOREG_STDOUT, '', new Error('ENOENT')),
    )
    const { loadMachineIdentity, _resetMachineIdentityForTest } = await import('../machine-identity')
    _resetMachineIdentityForTest()
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(id.mdmDeviceId).toBe('')
      expect(id.mdmSerial).toBe('')
      // Partial failure must not prevent host from being populated.
      expect(id.host).toBeTruthy()
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('host is always populated regardless of subprocess results', async () => {
    ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      makeExecFileMock('', '{}'),
    )
    const { loadMachineIdentity, _resetMachineIdentityForTest } = await import('../machine-identity')
    _resetMachineIdentityForTest()
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(typeof id.host).toBe('string')
      expect(id.host.length).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('returns empty machineId and MDM on non-darwin platforms', async () => {
    const { loadMachineIdentity, _resetMachineIdentityForTest } = await import('../machine-identity')
    _resetMachineIdentityForTest()
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(id.machineId).toBe('')
      expect(id.mdmDeviceId).toBe('')
      expect(id.mdmSerial).toBe('')
      expect(id.host.length).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })
})

describe('loadMachineIdentity — win32', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../machine-identity')
    mod._resetMachineIdentityForTest()
  })

  /** A reg query mock keyed on the value name (the last argv entry after '/v'). */
  function makeRegMock(values: Record<string, string>) {
    return vi.fn(
      (
        file: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        if (file !== 'reg') {
          cb(new Error(`unexpected command: ${file}`), { stdout: '' })
          return
        }
        const valueName = args[args.indexOf('/v') + 1]
        const value = values[valueName]
        if (value === undefined) {
          cb(new Error(`ERROR: The system was unable to find the specified registry key or value.`), { stdout: '' })
          return
        }
        cb(null, { stdout: `    ${valueName}    REG_SZ    ${value}\n` })
      },
    )
  }

  it('populates all three fields from the registry', async () => {
    ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      makeRegMock({
        MachineGuid: 'AABBCCDD-1122-3344-5566-778899AABBCC',
        MDMDeviceID: 'intune-device-abc',
        MDMSerialNumber: 'SER123456',
      }),
    )
    const { loadMachineIdentity } = await import('../machine-identity')
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(id.machineId).toBe('AABBCCDD-1122-3344-5566-778899AABBCC')
      expect(id.mdmDeviceId).toBe('intune-device-abc')
      expect(id.mdmSerial).toBe('SER123456')
      expect(id.host.length).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('a failing MDMDeviceID query yields empty string and still populates machineId', async () => {
    ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      makeRegMock({
        MachineGuid: 'AABBCCDD-1122-3344-5566-778899AABBCC',
        // MDMDeviceID and MDMSerialNumber deliberately absent (not enrolled).
      }),
    )
    const { loadMachineIdentity, _resetMachineIdentityForTest } = await import('../machine-identity')
    _resetMachineIdentityForTest()
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const id = await loadMachineIdentity()
      expect(id.machineId).toBe('AABBCCDD-1122-3344-5566-778899AABBCC')
      expect(id.mdmDeviceId).toBe('')
      expect(id.mdmSerial).toBe('')
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })
})
