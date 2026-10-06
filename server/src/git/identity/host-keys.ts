/**
 * The host user's own SSH keys: the public keys in `~/.ssh`, and which git
 * hosts `~/.ssh/config` pins each one to. Git on this server offers these
 * whenever the person has no Ion credential for a remote's host, so the
 * credential list shows them beside the ones Ion stores.
 */
import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { log as _log, warn as _warn } from '../../logger'

const TAG = 'git-identity-host-keys'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** A public key found in the host user's `~/.ssh`. */
export interface HostSshKey {
  /** The `.pub` file's name. */
  file: string
  type: string
  comment: string
  /** The whole public key line, safe to display and copy. */
  publicKey: string
  /** The `Host` names `~/.ssh/config` pins this key to with `IdentityFile`; empty when ssh offers it to every host. */
  pinnedHosts: string[]
}

/**
 * `~/.ssh/config`'s `IdentityFile` lines, as private-key file name to the
 * `Host` names of the block each sits in. A key outside every block, or
 * under `Host *`, is offered everywhere and is left out.
 */
function pinnedHostsByKeyFile(sshDir: string): Map<string, string[]> {
  const pinned = new Map<string, string[]>()
  let text: string
  try { text = readFileSync(join(sshDir, 'config'), 'utf-8') } catch (err) { log('no ssh config to read', { error: String(err) }); return pinned }
  let hosts: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const match = /^(\S+)[\s=]+(.+)$/.exec(line)
    if (!match || line.startsWith('#')) continue
    const keyword = match[1].toLowerCase()
    if (keyword === 'host') hosts = match[2].split(/\s+/).filter((h) => !/[*?!]/.test(h))
    else if (keyword === 'match') hosts = []
    else if (keyword === 'identityfile' && hosts.length > 0) {
      const file = basename(match[2].replace(/^"|"$/g, ''))
      pinned.set(file, [...(pinned.get(file) ?? []), ...hosts])
    }
  }
  return pinned
}

/** The public keys in the host's `~/.ssh`, each with the hosts it is pinned to. */
export function listHostSshKeys(home: string = homedir()): HostSshKey[] {
  const dir = join(home, '.ssh')
  let names: string[]
  try { names = readdirSync(dir) } catch (err) { log('no ~/.ssh to list', { dir, error: String(err) }); return [] }
  const pinned = pinnedHostsByKeyFile(dir)
  const keys: HostSshKey[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.pub')) continue
    try {
      const publicKey = readFileSync(join(dir, name), 'utf-8').trim()
      const [type = '', , ...rest] = publicKey.split(/\s+/)
      keys.push({ file: name, type, comment: rest.join(' '), publicKey, pinnedHosts: pinned.get(name.slice(0, -'.pub'.length)) ?? [] })
    } catch (err) {
      warn('public key unreadable', { file: name, error: String(err) })
    }
  }
  log('host ssh keys listed', { count: keys.length })
  return keys
}
