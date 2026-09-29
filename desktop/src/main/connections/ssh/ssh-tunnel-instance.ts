/**
 * The one SshTunnelManager the main process owns. Split from
 * `ssh-tunnel.ts` so tests construct their own manager with fakes while
 * `environment-connect.ts`, the SSH door, and the quit path share this one.
 */
import { SshTunnelManager } from './ssh-tunnel'

export const sshTunnels = new SshTunnelManager()
