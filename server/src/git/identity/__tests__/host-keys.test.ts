/** host-keys — the public keys in ~/.ssh, and the hosts ~/.ssh/config pins each one to. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listHostSshKeys } from '../host-keys'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ion-host-keys-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('listHostSshKeys', () => {
  it('yields nothing without a ~/.ssh', () => {
    expect(listHostSshKeys(home)).toEqual([])
  })

  it('lists public keys with type, comment and the whole key line', () => {
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3 user@example.org\n')
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'private')
    expect(listHostSshKeys(home)).toEqual([
      { file: 'id_ed25519.pub', type: 'ssh-ed25519', comment: 'user@example.org', publicKey: 'ssh-ed25519 AAAAC3 user@example.org', pinnedHosts: [] },
    ])
  })

  it('reports the hosts an IdentityFile line pins a key to, and ignores wildcard blocks', () => {
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_work.pub'), 'ssh-ed25519 WORK work@example.org\n')
    writeFileSync(join(home, '.ssh', 'id_any.pub'), 'ssh-ed25519 ANY any@example.org\n')
    writeFileSync(join(home, '.ssh', 'config'), [
      '# comment',
      'Host gitlab.example.org git.example.org',
      '  IdentityFile ~/.ssh/id_work',
      'Host *',
      '  IdentityFile ~/.ssh/id_any',
    ].join('\n'))
    const keys = listHostSshKeys(home)
    expect(keys.find((k) => k.file === 'id_work.pub')?.pinnedHosts).toEqual(['gitlab.example.org', 'git.example.org'])
    expect(keys.find((k) => k.file === 'id_any.pub')?.pinnedHosts).toEqual([])
  })
})
