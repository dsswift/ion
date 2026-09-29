/**
 * ssh-add-environment -- the SSH door, end to end.
 *
 *   connecting -> installing -> starting -> pairing -> done
 *
 * Probe the host, run the installer there, open the loopback forward,
 * mint a pairing link on the host and complete the same X25519 exchange the
 * pasted-link door runs (`pairing.ts`), but against the forward. The result
 * is an ordinary `paired` catalog target whose `via` is `ssh`, so every
 * later connect (`environment-connect.ts`) re-opens the forward and dials it.
 *
 * The SSH login proves an account on the host, and an install is that
 * account's. When the account already has a Studio Server, the door does
 * not reinstall it -- a laptop on an older build would downgrade it, and
 * the person's server is not this laptop's to replace -- it pairs this
 * desktop to the existing install on the port its server.json names. Update
 * is its own verb on the Environment page. A different account on the same
 * host is a different install, on its own port.
 *
 * Every stage transition and every installer line goes to `onProgress`; the
 * dialog shows them verbatim. Every failure is returned, never thrown:
 * the IPC handler relays `{ok:false, error}` to the dialog.
 */
import { hostname } from 'os'
import type { PairedEnvironmentTarget } from '@ion/shared/types-environments'
import type { SshAddEnvironmentProgress, SshAddEnvironmentResult } from '@ion/shared/types-ssh-environment'
import { parseSshDestination, SshError, type SshDestination, type SshSpawn } from './ssh-command'
import { probeHost, appraiseHost, describeHostAppraisal, installedPort, installOnHost, mintPairingLink, resolveBootstrapAssets, type BootstrapAssets, type InstallReceipt, type HostAppraisal } from './ssh-bootstrap'
import type { SshTunnelManager } from './ssh-tunnel'
import { pairEnvironment as defaultPairEnvironment, type PairEnvironmentRequest, type PairEnvironmentResult } from '../pairing'
import { log as _log, warn as _warn } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('ssh-add-environment', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('ssh-add-environment', msg, fields)
}

export interface SshAddEnvironmentOptions {
  /** As typed: `user@host`, `host:2222`, or an alias. */
  destinationInput: string
  /** Catalog label; defaults to the host's short name. */
  label?: string
  tunnels: SshTunnelManager
  onProgress: (progress: SshAddEnvironmentProgress) => void
  /** Injectable seams for tests. */
  spawn?: SshSpawn
  assets?: BootstrapAssets
  pair?: (req: PairEnvironmentRequest, clientLabel: string) => Promise<PairEnvironmentResult>
  install?: (dest: SshDestination, assets: BootstrapAssets, onLine: (line: string) => void) => Promise<InstallReceipt>
  appraise?: (dest: SshDestination) => Promise<HostAppraisal>
  clientLabel?: string
}

/** The provisional tunnel key used until the server's environment id is known. */
export function provisionalTunnelKey(dest: SshDestination): string {
  return `ssh:${dest.destination}${dest.port !== undefined ? `:${dest.port}` : ''}`
}

export async function addEnvironmentOverSsh(opts: SshAddEnvironmentOptions): Promise<SshAddEnvironmentResult> {
  const dest = parseSshDestination(opts.destinationInput)
  if (!dest) {
    warn('refused: destination did not parse', { input_length: opts.destinationInput.length })
    return { ok: false, error: 'Enter a host as user@host, host:port, or an SSH config alias.' }
  }
  const destinationLabel = opts.destinationInput.trim()
  const report = (stage: SshAddEnvironmentProgress['stage'], message: string): void => {
    log('progress', { destination: dest.destination, stage, message: message.slice(0, 200) })
    opts.onProgress({ destination: destinationLabel, stage, message })
  }
  const fail = (error: string): SshAddEnvironmentResult => {
    report('failed', error)
    return { ok: false, error }
  }
  const clientLabel = opts.clientLabel ?? `desktop ${hostname()}`
  const key = provisionalTunnelKey(dest)

  try {
    report('connecting', `Connecting to ${dest.destination}…`)
    const platform = await probeHost(dest, opts.spawn)
    report('connecting', `Host is ${platform.goos}/${platform.goarch}`)
    // Say what is already there before touching anything: a host being
    // re-added after a Studio-only removal keeps its conversations, keys,
    // and projects, and the operator should read that here, not discover it.
    const appraisal = await (opts.appraise ?? ((d) => appraiseHost(d, opts.spawn)))(dest)
    report('connecting', describeHostAppraisal(appraisal))

    let remotePort: number
    if (appraisal.studioVersion) {
      remotePort = installedPort(appraisal)
      log('existing install found; pairing only', { destination: dest.destination, studio_version: appraisal.studioVersion, remote_user: appraisal.user ?? '', remote_port: remotePort })
      report('installing', `Studio Server ${appraisal.studioVersion} is already installed for ${appraisal.user ?? 'this account'}; nothing to install`)
    } else {
      report('installing', 'Installing the Ion Studio Server on the host…')
      const assets = opts.assets ?? resolveBootstrapAssets()
      const receipt = opts.install
        ? await opts.install(dest, assets, (line) => report('installing', line))
        : await installOnHost({ dest, platform, assets, onLine: (line) => report('installing', line), spawn: opts.spawn })
      remotePort = receipt.port
      report('installing', `Server ${receipt.version} is running on the host (port ${receipt.port}${receipt.user ? `, account ${receipt.user}` : ''})`)
    }

    report('starting', `Opening a secure tunnel to port ${remotePort}…`)
    const leg = { destination: dest.destination, port: dest.port, remotePort }
    const { localPort } = await opts.tunnels.ensure(key, leg)
    report('starting', 'Tunnel is up')

    report('pairing', 'Pairing this desktop with the server…')
    const minted = await mintPairingLink(dest, clientLabel, opts.spawn)
    // The minted link names the host's advertised address; through the
    // tunnel the server is at the local end of the forward instead.
    const link = `ion-studio://pair?code=${encodeURIComponent(minted.code)}&url=${encodeURIComponent(`http://127.0.0.1:${localPort}`)}`
    const paired = await (opts.pair ?? defaultPairEnvironment)({ link, label: opts.label }, clientLabel)
    if (!paired.ok) {
      opts.tunnels.stop(key)
      return fail(paired.error)
    }
    const environmentId = paired.target.environmentId ?? paired.target.credentialRef
    opts.tunnels.rekey(key, environmentId)
    const target: PairedEnvironmentTarget = {
      ...paired.target,
      via: 'ssh',
      url: `http://127.0.0.1:${remotePort}`,
      ssh: leg,
      label: (opts.label ?? '').trim() || paired.target.label || dest.destination.replace(/^.*@/, ''),
    }
    report('done', `Paired with ${target.label}`)
    log('ssh environment added', { destination: dest.destination, environment_id: environmentId, label: target.label, local_port: localPort, remote_port: remotePort })
    return { ok: true, target }
  } catch (err) {
    opts.tunnels.stop(key)
    const message = err instanceof SshError ? err.message : err instanceof Error ? err.message : String(err)
    warn('ssh environment add failed', { destination: dest.destination, kind: err instanceof SshError ? err.kind : 'error', error: message })
    return fail(message)
  }
}
