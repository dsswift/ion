import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hostname } from 'os'

vi.mock('../../logger', () => ({
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
}))

vi.mock('../../machine-identity', () => ({
  getMachineIdentity: () => ({
    host: 'test-host',
    machineId: 'FAKE-DESKTOP-UUID-1234',
    mdmDeviceId: '',
    mdmSerial: '',
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: vi.fn(() => true) }
})

vi.mock('../../settings-store', () => ({
  SETTINGS_FILE: '/tmp/fake-settings.json',
  readSettings: vi.fn(() => ({ pairedDevices: [] })),
  writeSettings: vi.fn(),
}))

vi.mock('../crypto', () => ({
  generateKeyPair: () => ({
    publicKey: Buffer.alloc(32, 1),
    secretKey: Buffer.alloc(32, 2),
  }),
  deriveSharedSecret: () => Buffer.alloc(32, 3),
  deriveChannelId: () => 'test-channel-id-1234567890',
}))

vi.mock('../../state', () => ({
  state: { remoteTransport: null },
  pairingManager: {
    completePairing: vi.fn(),
  },
}))

vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../snapshot', () => ({ getRemoteTabStates: vi.fn(async () => ({ tabs: [], resourceManifest: {} })) }))
vi.mock('../../../shared/recent-directories', () => ({ recentLocalDirectories: vi.fn(() => []) }))

const { readSettings, writeSettings } = await import('../../settings-store')
const { state, pairingManager } = await import('../../state')
const { handlePairRequest } = await import('../pairing-handler')

describe('stable pairing: mobileDeviceId', () => {
  beforeEach(() => {
    vi.mocked(readSettings).mockReturnValue({ pairedDevices: [] })
    vi.mocked(writeSettings).mockClear()
  })

  it('stores mobileDeviceId on the paired device record (recovery path)', () => {
    vi.mocked(readSettings).mockReturnValue({
      pairedDevices: [{ id: 'old-id', name: 'iPhone', mobileDeviceId: 'IOS-UUID-ABCD' }],
    })

    const respond = vi.fn()
    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-ABCD',
      respond,
      reject: vi.fn(),
    })

    expect(respond).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(writeSettings).mock.calls[0]?.[0]
    expect(saved.pairedDevices[0].mobileDeviceId).toBe('IOS-UUID-ABCD')
  })

  it('matches recovery by mobileDeviceId even when deviceName changed', () => {
    vi.mocked(readSettings).mockReturnValue({
      pairedDevices: [{
        id: 'old-id',
        name: 'Old iPhone Name',
        mobileDeviceId: 'IOS-UUID-ABCD',
      }],
    })

    const respond = vi.fn()
    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'New iPhone Name',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-ABCD',
      respond,
      reject: vi.fn(),
    })

    expect(respond).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(writeSettings).mock.calls[0]?.[0]
    expect(saved.pairedDevices).toHaveLength(1)
    expect(saved.pairedDevices[0].name).toBe('New iPhone Name')
    expect(saved.pairedDevices[0].mobileDeviceId).toBe('IOS-UUID-ABCD')
  })

  it('falls back to name matching when mobileDeviceId not provided', () => {
    vi.mocked(readSettings).mockReturnValue({
      pairedDevices: [{ id: 'old-id', name: 'iPhone' }],
    })

    const respond = vi.fn()
    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      respond,
      reject: vi.fn(),
    })

    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('deduplicates by mobileDeviceId during device persistence', () => {
    vi.mocked(readSettings).mockReturnValue({
      pairedDevices: [
        { id: 'existing-id', name: 'iPhone', mobileDeviceId: 'IOS-UUID-ABCD' },
      ],
    })

    const respond = vi.fn()
    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'Renamed iPhone',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-ABCD',
      respond,
      reject: vi.fn(),
    })

    const saved = vi.mocked(writeSettings).mock.calls[0]?.[0]
    expect(saved.pairedDevices).toHaveLength(1)
    expect(saved.pairedDevices[0].name).toBe('Renamed iPhone')
  })
})

describe('stable pairing: recovery without a matching record', () => {
  beforeEach(() => {
    vi.mocked(readSettings).mockReturnValue({ pairedDevices: [] })
    vi.mocked(writeSettings).mockClear()
    vi.mocked(pairingManager.completePairing).mockClear()
  })

  // A recovery re-pair carries no PIN by design (`code: ''`). When no record
  // matched, the request used to fall through to completePairing(''), which
  // reported "Incorrect pairing code" for a request that never offered one
  // AND — the damaging part — incremented the pairing session's failed-attempt
  // counter. A phone retrying recovery in the background could burn through
  // MAX_FAILED_ATTEMPTS and cancel the PIN session the operator was using.
  it('never consumes a pairing attempt when no recovery record exists', () => {
    const reject = vi.fn()
    handlePairRequest({
      code: '',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-UNKNOWN',
      respond: vi.fn(),
      reject,
    })

    expect(pairingManager.completePairing).not.toHaveBeenCalled()
    expect(reject).toHaveBeenCalledTimes(1)
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('rejects with a reason naming recovery, not an incorrect code', () => {
    const reject = vi.fn()
    handlePairRequest({
      code: '',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-UNKNOWN',
      respond: vi.fn(),
      reject,
    })

    expect(String(reject.mock.calls[0][0])).toMatch(/recovery/i)
  })

  it('still honours a normal PIN pairing (recovery flag absent)', () => {
    vi.mocked(pairingManager.completePairing).mockReturnValue({
      device: {
        id: 'new-id', name: 'iPhone', pairedAt: 'now', lastSeen: null,
        channelId: 'chan', sharedSecret: Buffer.alloc(32, 7).toString('base64'),
      },
      ourPublicKey: Buffer.alloc(32, 1).toString('base64'),
      relayConfig: { relayUrl: '', relayApiKey: '' },
      sharedSecretBuf: Buffer.alloc(32, 7),
    } as never)

    const respond = vi.fn()
    handlePairRequest({
      code: '928299',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      mobileDeviceId: 'IOS-UUID-ABCD',
      respond,
      reject: vi.fn(),
    })

    expect(pairingManager.completePairing).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledTimes(1)
  })

  // A corrupt-secret record is still a valid recovery target: mobileDeviceId
  // is what makes the codeless repair possible, so quarantine must never
  // delete the record.
  it('accepts recovery for a record whose stored secret is unusable', () => {
    vi.mocked(readSettings).mockReturnValue({
      pairedDevices: [{
        id: 'old-id',
        name: 'iPhone',
        mobileDeviceId: 'IOS-UUID-ABCD',
        sharedSecret: 'enc:v1:c3RhbGUta2V5Y2hhaW4tYmxvYg==',
      }],
    })

    const respond = vi.fn()
    const reject = vi.fn()
    handlePairRequest({
      code: '',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-ABCD',
      respond,
      reject,
    })

    expect(reject).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(writeSettings).mock.calls[0]?.[0]
    expect(saved.pairedDevices[0].sharedSecret).not.toContain('enc:')
  })
})

describe('stable pairing: desktopId in response', () => {
  beforeEach(() => {
    vi.mocked(readSettings).mockReturnValue({ pairedDevices: [] })
    vi.mocked(writeSettings).mockClear()
  })

  it('includes desktopId in pair_response (recovery path)', () => {
    vi.mocked(readSettings).mockReturnValue({
      pairedDevices: [{ id: 'old-id', name: 'iPhone' }],
    })

    const respond = vi.fn()
    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      respond,
      reject: vi.fn(),
    })

    expect(respond).toHaveBeenCalledTimes(1)
    const response = respond.mock.calls[0][0]
    expect(response.type).toBe('pair_response')
    expect(response.desktopId).toBe('FAKE-DESKTOP-UUID-1234')
  })

  it('includes desktopId in pair_response (normal path)', () => {
    vi.mocked(pairingManager.completePairing).mockReturnValue({
      device: {
        id: 'new-id',
        name: 'iPhone',
        pairedAt: new Date().toISOString(),
        lastSeen: null,
        channelId: 'chan-1234',
        sharedSecret: Buffer.alloc(32).toString('base64'),
      },
      ourPublicKey: Buffer.alloc(32).toString('base64'),
      relayConfig: { relayUrl: '', relayApiKey: '' },
      sharedSecretBuf: Buffer.alloc(32),
    })

    const respond = vi.fn()
    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      respond,
      reject: vi.fn(),
    })

    expect(respond).toHaveBeenCalledTimes(1)
    const response = respond.mock.calls[0][0]
    expect(response.desktopId).toBe('FAKE-DESKTOP-UUID-1234')
  })
})

describe('stable pairing: superseded relay cleanup on re-pair', () => {
  beforeEach(() => {
    vi.mocked(readSettings).mockReturnValue({ pairedDevices: [] })
    vi.mocked(writeSettings).mockClear()
    state.remoteTransport = null
  })

  it('removes old relay client when re-pair changes channelId', () => {
    const removeDevice = vi.fn()
    const addDevice = vi.fn()
    state.remoteTransport = { removeDevice, addDevice, send: vi.fn() } as any

    vi.mocked(readSettings).mockImplementation(() => ({
      pairedDevices: [
        { id: 'old-device-id', name: 'iPhone', mobileDeviceId: 'IOS-UUID-ABCD', channelId: 'old-channel' },
      ],
    }))

    const respond = vi.fn()
    handlePairRequest({
      code: '',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'iPhone',
      recovery: true,
      mobileDeviceId: 'IOS-UUID-ABCD',
      respond,
      reject: vi.fn(),
    })

    expect(respond).toHaveBeenCalledTimes(1)
    // Verify state.remoteTransport block was entered at all
    expect(addDevice).toHaveBeenCalledTimes(1)
    // deriveChannelId mock returns 'test-channel-id-1234567890', so new
    // device.id = 'test-channel-id-' (first 16 chars), which differs from
    // 'old-device-id'. The handler should remove the old relay before adding.
    expect(removeDevice).toHaveBeenCalledWith('old-device-id')
    expect(addDevice.mock.calls[0][0].id).toBe('test-channel-id-')
  })

  it('does not remove when no superseded entry exists', () => {
    const removeDevice = vi.fn()
    const addDevice = vi.fn()
    state.remoteTransport = { removeDevice, addDevice, send: vi.fn() } as any

    vi.mocked(readSettings).mockReturnValue({ pairedDevices: [] })

    vi.mocked(pairingManager.completePairing).mockReturnValue({
      device: {
        id: 'brand-new-id',
        name: 'New Phone',
        pairedAt: new Date().toISOString(),
        lastSeen: null,
        channelId: 'chan-new',
        sharedSecret: Buffer.alloc(32).toString('base64'),
      },
      ourPublicKey: Buffer.alloc(32).toString('base64'),
      relayConfig: { relayUrl: '', relayApiKey: '' },
      sharedSecretBuf: Buffer.alloc(32),
    })

    handlePairRequest({
      code: '123456',
      publicKey: Buffer.alloc(32).toString('base64'),
      deviceName: 'New Phone',
      respond: vi.fn(),
      reject: vi.fn(),
    })

    expect(removeDevice).not.toHaveBeenCalled()
    expect(addDevice).toHaveBeenCalledTimes(1)
  })
})

describe('stable pairing: Bonjour TXT record', () => {
  const spawnMock = vi.fn()
  const spawnSyncMock = vi.fn()

  beforeEach(async () => {
    vi.resetModules()
    spawnMock.mockReset()
    spawnSyncMock.mockReset()

    spawnSyncMock.mockReturnValue({ stdout: '', status: 1, error: undefined })

    const { EventEmitter } = await import('events')
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as any
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.pid = 9999
      child.kill = vi.fn()
      return child
    })

    vi.doMock('child_process', () => ({
      spawn: (...args: unknown[]) => spawnMock(...args),
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    }))
  })

  it('appends desktopId as TXT record to dns-sd args', async () => {
    const { BonjourAdvertiser } = await import('../lan-bonjour')
    const advertiser = new BonjourAdvertiser({
      port: 19999,
      advertise: true,
      desktopId: 'MY-UUID-5678',
    })

    advertiser.start()

    const dnssdCalls = spawnMock.mock.calls.filter((c: unknown[]) => c[0] === '/usr/bin/dns-sd')
    expect(dnssdCalls).toHaveLength(1)
    const args = dnssdCalls[0][1] as string[]
    expect(args).toContain('desktopId=MY-UUID-5678')
    expect(args).toEqual([
      '-R', hostname().replace(/\.local$/, ''), '_ion._tcp', 'local', '19999',
      'desktopId=MY-UUID-5678',
    ])

    advertiser.stop()
  })

  it('omits TXT record when desktopId is not provided', async () => {
    const { BonjourAdvertiser } = await import('../lan-bonjour')
    const advertiser = new BonjourAdvertiser({
      port: 19999,
      advertise: true,
    })

    advertiser.start()

    const dnssdCalls = spawnMock.mock.calls.filter((c: unknown[]) => c[0] === '/usr/bin/dns-sd')
    expect(dnssdCalls).toHaveLength(1)
    const args = dnssdCalls[0][1] as string[]
    expect(args).toEqual([
      '-R', hostname().replace(/\.local$/, ''), '_ion._tcp', 'local', '19999',
    ])

    advertiser.stop()
  })
})
