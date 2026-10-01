/**
 * ssh-add-environment -- the door's orchestration: stage order, the tunnel
 * opened on a provisional key and rekeyed to the environment id, the pairing
 * link rewritten to the tunnel's local end, the `via: 'ssh'` target shape,
 * and teardown on every failure. Every remote step is injected.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nowhere' } }))
vi.mock('../../../device-settings', () => ({ deviceId: () => 'device-test' }))
vi.mock('../ssh-bootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssh-bootstrap')>()
  return {
    ...actual,
    probeHost: vi.fn(async () => ({ goos: 'darwin', goarch: 'amd64', home: '/Users/j' })),
    appraiseHost: vi.fn(async () => ({ studioVersion: null, user: 'josh', port: null, conversations: 2, gitCredentialHosts: 1, projects: 3 })),
    mintPairingLink: vi.fn(async () => ({ url: 'ion-studio://pair?code=abc&url=http://oscar.local:7331', code: 'abc', expiresAt: 1 })),
  }
})

import { addEnvironmentOverSsh, provisionalTunnelKey } from '../ssh-add-environment'
import { probeHost, mintPairingLink, type BootstrapAssets } from '../ssh-bootstrap'
import { SshTunnelManager } from '../ssh-tunnel'
import type { SshAddEnvironmentProgress } from '@ion/shared/types-ssh-environment'
import type { PairedEnvironmentTarget } from '@ion/shared/types-environments'

const assets: BootstrapAssets = { installerPath: '/x/install.sh', serverVersion: '0.2.0', isDev: false, repoRoot: null }

function tunnelManager(): SshTunnelManager {
  return new SshTunnelManager({
    spawn: () => ({ stdin: { end() {} }, stderr: { on() {} }, on() {}, exitCode: null, kill() { return true } }) as never,
    reservePort: async () => 50123,
    probe: async () => true,
  })
}

describe('addEnvironmentOverSsh', () => {
  it('walks connecting -> installing -> starting -> pairing -> done and returns a via:ssh target', async () => {
    const tunnels = tunnelManager()
    const stages: SshAddEnvironmentProgress[] = []
    const pairedTarget: PairedEnvironmentTarget = { kind: 'paired', label: 'oscar', url: 'http://127.0.0.1:50123', credentialRef: 'env-42', via: 'lan', environmentId: 'env-42' }
    const pair = vi.fn(async () => ({ ok: true as const, target: pairedTarget }))
    const install = vi.fn(async (_d: unknown, _a: unknown, onLine: (l: string) => void) => { onLine('==> installing 0.2.0'); return { ok: true as const, version: '0.2.0', port: 7331, dataDir: '/Users/j/.ion' } })

    const result = await addEnvironmentOverSsh({ destinationInput: 'josh@oscar.local', tunnels, onProgress: (p) => stages.push(p), assets, pair, install, clientLabel: 'desktop mac' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target.via).toBe('ssh')
    expect(result.target.ssh).toEqual({ destination: 'josh@oscar.local', port: undefined, remotePort: 7331 })
    expect(result.target.url).toBe('http://127.0.0.1:7331')
    expect(result.target.label).toBe('oscar')
    expect(result.target.credentialRef).toBe('env-42')

    expect(stages.map((s) => s.stage)).toEqual(['connecting', 'connecting', 'connecting', 'installing', 'installing', 'installing', 'starting', 'starting', 'pairing', 'done'])
    expect(stages.some((s) => s.message === '==> installing 0.2.0')).toBe(true)
    // A re-added host says what it already has before anything is installed.
    expect(stages[2].message).toBe('Already on the host: no Studio Server for josh, 2 conversations, git credentials for 1 host, 3 projects. Everything is kept.')
    expect(stages.every((s) => s.destination === 'josh@oscar.local')).toBe(true)

    // The pairing ran against the tunnel's local end, not the host's advertised address.
    const link = (pair.mock.calls[0] as unknown as [{ link: string }])[0].link
    expect(link).toContain('code=abc')
    expect(link).toContain(encodeURIComponent('http://127.0.0.1:50123'))
    expect(vi.mocked(mintPairingLink).mock.calls[0][1]).toBe('desktop mac')

    // The forward now lives under the environment id.
    expect(tunnels.localPortOf('env-42')).toBe(50123)
    expect(tunnels.localPortOf(provisionalTunnelKey({ destination: 'josh@oscar.local' }))).toBeNull()
    expect(probeHost).toHaveBeenCalled()
  })

  // The account already has a server: the door pairs to it on the port its
  // server.json names and never runs the installer (a laptop on an older
  // build would downgrade it; Update is its own verb on the Environment page).
  it('pairs to an existing install on its own port without reinstalling', async () => {
    const tunnels = tunnelManager()
    const stages: SshAddEnvironmentProgress[] = []
    const pairedTarget: PairedEnvironmentTarget = { kind: 'paired', label: 'oscar', url: 'http://127.0.0.1:50123', credentialRef: 'env-42', via: 'lan', environmentId: 'env-42' }
    const pair = vi.fn(async () => ({ ok: true as const, target: pairedTarget }))
    const install = vi.fn(async () => ({ ok: true as const, version: '0.2.0', port: 7331, dataDir: '/d' }))
    const appraise = vi.fn(async () => ({ studioVersion: '0.1.0', user: 'josh', port: 7333, conversations: 0, gitCredentialHosts: 0, projects: 0 }))

    const result = await addEnvironmentOverSsh({ destinationInput: 'josh@oscar.local', tunnels, onProgress: (p) => stages.push(p), assets, pair, install, appraise })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(install).not.toHaveBeenCalled()
    expect(result.target.ssh).toEqual({ destination: 'josh@oscar.local', port: undefined, remotePort: 7333 })
    expect(result.target.url).toBe('http://127.0.0.1:7333')
    expect(stages.map((s) => s.stage)).toEqual(['connecting', 'connecting', 'connecting', 'installing', 'starting', 'starting', 'pairing', 'done'])
    expect(stages[3].message).toBe('Studio Server 0.1.0 is already installed for josh; nothing to install')
    expect(stages[4].message).toBe('Opening a secure tunnel to port 7333…')
  })

  it('refuses a malformed destination before touching ssh', async () => {
    const result = await addEnvironmentOverSsh({ destinationInput: '   ', tunnels: tunnelManager(), onProgress: () => {}, assets })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/user@host/) })
  })

  it('reports failed, stops the tunnel, and returns the installer error when the install fails', async () => {
    const tunnels = tunnelManager()
    const stages: SshAddEnvironmentProgress[] = []
    const install = vi.fn(async () => { throw new Error('The installer finished without a receipt.') })
    const result = await addEnvironmentOverSsh({ destinationInput: 'j@h', tunnels, onProgress: (p) => stages.push(p), assets, install })
    expect(result).toEqual({ ok: false, error: 'The installer finished without a receipt.' })
    expect(stages.at(-1)?.stage).toBe('failed')
    expect(tunnels.localPortOf(provisionalTunnelKey({ destination: 'j@h' }))).toBeNull()
  })

  it('tears the tunnel down when pairing is refused', async () => {
    const tunnels = tunnelManager()
    const install = vi.fn(async () => ({ ok: true as const, version: '0.2.0', port: 7331, dataDir: '/d' }))
    const pair = vi.fn(async () => ({ ok: false as const, error: 'That pairing link was already used.' }))
    const result = await addEnvironmentOverSsh({ destinationInput: 'j@h', tunnels, onProgress: () => {}, assets, install, pair })
    expect(result).toEqual({ ok: false, error: 'That pairing link was already used.' })
    expect(tunnels.localPortOf(provisionalTunnelKey({ destination: 'j@h' }))).toBeNull()
  })
})
