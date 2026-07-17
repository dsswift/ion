import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process.execFile so no subprocesses run in tests.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

// Mock logger to avoid file I/O.
vi.mock('../logger', () => ({
  log: vi.fn(),
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
