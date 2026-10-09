/**
 * environment-connect over ssh -- a `via: 'ssh'` target opens the forward
 * first and dials the tunnel's local end for both `/auth/config` and the
 * socket, reports transport `ssh` (route `tcp`), and closes the forward on disconnect.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../broker-instance', () => ({
  broker: { onFrame: vi.fn(() => () => {}), connect: vi.fn(), disconnect: vi.fn(), phaseOf: vi.fn(() => undefined as unknown) },
}))
vi.mock('../ssh/ssh-tunnel-instance', () => ({
  sshTunnels: { ensure: vi.fn(async () => ({ localPort: 51234 })), localPortOf: vi.fn(() => 51234), stop: vi.fn() },
}))
vi.mock('../transport-tcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport-tcp')>()
  return {
    ...actual,
    fetchAuthConfig: vi.fn(async () => ({ nonce: 'n1' })),
    connectTcp: vi.fn(() => ({ on() {}, close() {} })),
    connectSealedTcp: vi.fn(() => ({ on() {}, close() {} })),
  }
})

import { connectEnvironment, disconnectEnvironment } from '../environment-connect'
import { broker } from '../broker-instance'
import { sshTunnels } from '../ssh/ssh-tunnel-instance'
import { fetchAuthConfig, connectTcp, connectSealedTcp } from '../transport-tcp'
import { _setConnectionsFilePathForTest, saveCredential } from '../credentials'
import { encodePairedSecret } from '../paired-secret'
import type { PairedEnvironmentTarget } from '@ion/shared/types-environments'

const target: PairedEnvironmentTarget = {
  kind: 'paired', label: 'devbox', url: 'http://127.0.0.1:7331', credentialRef: 'env-ssh', via: 'ssh', environmentId: 'env-ssh',
  ssh: { destination: 'josh@devbox.local', remotePort: 7331 },
}

describe('connectEnvironment via ssh', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-env-connect-ssh-'))
    _setConnectionsFilePathForTest(join(dir, 'desktop-connections.json'))
    vi.mocked(broker.connect).mockClear()
    vi.mocked(sshTunnels.ensure).mockClear()
    vi.mocked(fetchAuthConfig).mockClear()
    vi.mocked(connectTcp).mockClear()
    vi.mocked(connectSealedTcp).mockClear()
    saveCredential('env-ssh', 'paired', encodePairedSecret({ clientId: 'c1', sharedSecret: Buffer.alloc(32, 7) }))
  })

  it('opens the forward, reads /auth/config through it, and dials the local port with a paired credential', async () => {
    await connectEnvironment('env-ssh', 'devbox', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(sshTunnels.ensure).toHaveBeenCalledWith('env-ssh', target.ssh)
    expect(fetchAuthConfig).toHaveBeenCalledWith('http://127.0.0.1:51234')
    // The forward is its own hop: never reported as the LAN's `tcp`.
    expect(attempt.transport).toBe('ssh')
    expect(attempt.route).toBe('tcp')
    expect(attempt.credential.kind).toBe('paired')
    expect(vi.mocked(broker.connect).mock.calls[0][0].transport).toBe('ssh')
    expect(connectTcp).toHaveBeenCalledWith('http://127.0.0.1:51234')
  })

  // The server cannot tell an ssh-forwarded client from any other TCP client,
  // so the forward gets no exemption: once the server says it opens sealed
  // frames, the paired socket is sealed with the pairing's own id and secret.
  it('seals the paired socket once the server advertises sealed tcp', async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValueOnce({ nonce: 'n1', sealedTcp: true })
    await connectEnvironment('env-ssh', 'devbox', target)
    await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(connectSealedTcp).toHaveBeenCalledWith('http://127.0.0.1:51234', 'c1', Buffer.alloc(32, 7))
    expect(connectTcp).not.toHaveBeenCalled()
  })

  // The attempt refuses, not the connect call: a target the broker holds
  // keeps retrying, which is what lets an environment recover on its own.
  it('refuses the attempt when the ssh leg is missing', async () => {
    const broken = { ...target, ssh: undefined }
    await connectEnvironment('env-ssh', 'devbox', broken)
    await expect(vi.mocked(broker.connect).mock.calls[0][0].open()).rejects.toThrow(/no ssh leg/)
    expect(sshTunnels.ensure).not.toHaveBeenCalled()
  })

  it('stops the forward on disconnect', () => {
    disconnectEnvironment('env-ssh')
    expect(broker.disconnect).toHaveBeenCalledWith('env-ssh')
    expect(sshTunnels.stop).toHaveBeenCalledWith('env-ssh')
  })
})
