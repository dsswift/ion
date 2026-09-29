/**
 * ssh-bootstrap -- the pure parsers (host platform, installer receipt,
 * minted link) and the two branches of installOnHost: a development desktop
 * packages the bundle from its repo and ships it (a failed build or a
 * missing repo is refused by name), a released desktop pins the release
 * version. The ssh spawn and the bundle build are faked.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nowhere' } }))

import { parseHostPlatform, parseInstallReceipt, parseMintedLink, installOnHost, mintPairingLink, SSH_DOOR_SCOPES, parseHostAppraisal, describeHostAppraisal, installedPort, HOST_APPRAISAL_COMMAND, type BootstrapAssets } from '../ssh-bootstrap'
import type { SshSpawn } from '../ssh-command'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'

function scriptedSpawn(answers: Array<{ stdout: string; code?: number }>, seen: Array<{ args: string[]; stdin: string }>): SshSpawn {
  return (_cmd, args) => {
    const answer = answers.shift() ?? { stdout: '', code: 0 }
    const child = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const record = { args, stdin: '' }
    seen.push(record)
    child.stdin.on('data', (c: Buffer) => { record.stdin += c.toString() })
    setTimeout(() => {
      child.stdout.end(answer.stdout)
      child.stderr.end()
      child.emit('close', answer.code ?? 0, null)
    }, 0)
    return child
  }
}

describe('parseHostPlatform', () => {
  it('maps uname output to goos/goarch and refuses unsupported hosts', () => {
    expect(parseHostPlatform('Darwin\nx86_64\n/Users/josh\n')).toEqual({ goos: 'darwin', goarch: 'amd64', home: '/Users/josh' })
    expect(parseHostPlatform('Linux\naarch64\n/home/u\n')).toEqual({ goos: 'linux', goarch: 'arm64', home: '/home/u' })
    expect(() => parseHostPlatform('MINGW64_NT\nx86_64\n/c/u\n')).toThrow(/macOS and Linux only/)
    expect(() => parseHostPlatform('Linux\nriscv64\n/h\n')).toThrow(/architecture/)
  })
})

describe('host appraisal', () => {
  it('parses the key=value lines and words a fresh host differently from a re-added one', () => {
    expect(parseHostAppraisal('studio=-\nuser=josh\nport=-\nconversations=0\ngit_credentials=0\nprojects=0\n')).toEqual({ studioVersion: null, user: 'josh', port: null, conversations: 0, gitCredentialHosts: 0, projects: 0 })
    const again = parseHostAppraisal('studio=0.1.0\nuser=josh\nport=7332\nconversations=12\ngit_credentials=1\nprojects=3\n')
    expect(again).toEqual({ studioVersion: '0.1.0', user: 'josh', port: 7332, conversations: 12, gitCredentialHosts: 1, projects: 3 })
    expect(describeHostAppraisal(parseHostAppraisal(''))).toBe('Fresh host: no Ion install found.')
    // An existing install is the account's: it is paired to, never reinstalled, on the port its server.json names.
    expect(describeHostAppraisal(again)).toMatch(/^Already on the host: Studio Server 0.1.0 for josh on port 7332 \(kept as is; this desktop will only be paired\), 12 conversations, git credentials for 1 host, 3 projects/)
    expect(installedPort(again)).toBe(7332)
    expect(installedPort({ ...again, port: null })).toBe(7331)
    expect(describeHostAppraisal({ studioVersion: null, user: null, port: null, conversations: 1, gitCredentialHosts: 0, projects: 0 })).toBe('Already on the host: no Studio Server, 1 conversation. Everything is kept.')
    // POSIX sh only: no bashisms, every probe guarded so a missing file yields a zero rather than an error.
    expect(HOST_APPRAISAL_COMMAND).not.toMatch(/\[\[|\$\(\(|==/)
    expect(HOST_APPRAISAL_COMMAND.split('; ').filter((s) => s.startsWith('echo')).length).toBe(6)
  })
})

describe('parseInstallReceipt', () => {
  it('takes the last ok receipt line and ignores brace-led noise', () => {
    const out = '==> installing\n{"not":"it"}\n{"ok":true,"version":"0.2.0","port":7331,"dataDir":"/Users/j/.ion"}\n'
    expect(parseInstallReceipt(out)).toEqual({ ok: true, version: '0.2.0', port: 7331, dataDir: '/Users/j/.ion' })
  })
  it('fails with the output tail when no receipt is present', () => {
    expect(() => parseInstallReceipt('==> a\nion studio: readiness: timed out\n')).toThrow(/readiness: timed out/)
  })
})

describe('parseMintedLink', () => {
  it('reads the json line ion studio pair --json prints', () => {
    expect(parseMintedLink('==> minting\n{"url":"ion-studio://pair?code=ab&url=http://h:7331","code":"ab","expiresAt":5}\n')).toEqual({ url: 'ion-studio://pair?code=ab&url=http://h:7331', code: 'ab', expiresAt: 5 })
    expect(() => parseMintedLink('nothing')).toThrow(/did not print a pairing link/)
  })
})

describe('installOnHost', () => {
  const platform = { goos: 'darwin' as const, goarch: 'amd64' as const, home: '/Users/j' }
  const dest = { destination: 'j@h' }

  it('a packaged desktop pipes the installer with the pinned server version and returns the receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-ssh-boot-'))
    const installerPath = join(dir, 'install.sh')
    writeFileSync(installerPath, '#!/bin/sh\necho installer\n')
    const assets: BootstrapAssets = { installerPath, serverVersion: '0.2.0', isDev: false, repoRoot: null }
    const seen: Array<{ args: string[]; stdin: string }> = []
    const lines: string[] = []
    const receipt = await installOnHost({
      dest, platform, assets, installArgs: ['--label', 'lab'],
      onLine: (l) => lines.push(l),
      spawn: scriptedSpawn([{ stdout: '==> hi\n{"ok":true,"version":"0.2.0","port":7331,"dataDir":"/Users/j/.ion"}\n' }], seen),
    })
    expect(receipt.port).toBe(7331)
    expect(seen).toHaveLength(1)
    const command = seen[0].args.at(-1) ?? ''
    expect(command).toContain(`ION_STUDIO_VERSION='0.2.0'`)
    expect(command).toContain(`ION_STUDIO_INSTALL_ARGS='--label lab'`)
    expect(command).toMatch(/sh -s$/)
    expect(seen[0].stdin).toContain('echo installer')
    expect(lines).toContain('==> hi')
  })

  it('a development desktop packages the bundle for the host platform, copies it, and points ION_STUDIO_BUNDLE at it', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ion-ssh-boot-repo-'))
    // A stale bundle from an earlier run must not short-circuit the build.
    mkdirSync(join(repoRoot, 'build', 'deploy'), { recursive: true })
    writeFileSync(join(repoRoot, 'build', 'deploy', 'ion-studio-server-darwin-amd64.tar.gz'), 'stale')
    const installerPath = join(repoRoot, 'install.sh')
    writeFileSync(installerPath, 'echo dev\n')
    const assets: BootstrapAssets = { installerPath, serverVersion: '0.1.0', isDev: true, repoRoot }
    const seen: Array<{ args: string[]; stdin: string }> = []
    const copied: string[] = []
    const lines: string[] = []
    const built: string[] = []
    const receipt = await installOnHost({
      dest, platform, assets,
      onLine: (l) => lines.push(l),
      packageBundle: async (root, p, onLine) => {
        built.push(`${root} ${p.goos}/${p.goarch}`)
        onLine('==> building engine')
        writeFileSync(join(root, 'build', 'deploy', 'ion-studio-server-darwin-amd64.tar.gz'), 'fresh')
      },
      copyToHost: async (_d, local, remote) => { copied.push(`${local} -> ${remote}`) },
      spawn: scriptedSpawn([{ stdout: '' }, { stdout: '{"ok":true,"version":"0.1.0","port":7331,"dataDir":"/Users/j/.ion"}\n' }], seen),
    })
    expect(receipt.version).toBe('0.1.0')
    expect(built).toEqual([`${repoRoot} darwin/amd64`])
    expect(lines).toContain('==> building engine')
    expect(copied[0]).toBe(`${join(repoRoot, 'build', 'deploy', 'ion-studio-server-darwin-amd64.tar.gz')} -> /Users/j/.ion/studio-server/incoming/ion-studio-server-darwin-amd64.tar.gz`)
    expect(seen[0].args.at(-1)).toContain('mkdir -p')
    expect(seen[1].args.at(-1)).toContain(`ION_STUDIO_BUNDLE='/Users/j/.ion/studio-server/incoming/ion-studio-server-darwin-amd64.tar.gz'`)
    expect(seen[1].args.at(-1)).not.toContain('ION_STUDIO_VERSION')
  })

  it('a development desktop whose build fails, or whose repo is gone, is refused by name', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ion-ssh-boot-empty-'))
    const installerPath = join(repoRoot, 'install.sh')
    writeFileSync(installerPath, 'x')
    const assets: BootstrapAssets = { installerPath, serverVersion: '0.1.0', isDev: true, repoRoot }
    await expect(installOnHost({
      dest, platform, assets, spawn: scriptedSpawn([], []),
      packageBundle: async () => { throw new Error('make package-studio-server GOOS=darwin GOARCH=amd64 failed in repo (exit 2)') },
    })).rejects.toThrow(/make package-studio-server GOOS=darwin GOARCH=amd64 failed/)
    await expect(installOnHost({
      dest, platform, assets, spawn: scriptedSpawn([], []),
      packageBundle: async () => { /* wrote nothing */ },
    })).rejects.toThrow(/wrote no bundle/)
    await expect(installOnHost({
      dest, platform, assets: { ...assets, repoRoot: join(repoRoot, 'moved-away') }, spawn: scriptedSpawn([], []),
      packageBundle: async () => { throw new Error('must not be called') },
    })).rejects.toThrow(/is not on this machine/)
  })
})

describe('mintPairingLink', () => {
  it('runs ion studio pair on the host with the label and the admin-inclusive scopes', async () => {
    const seen: Array<{ args: string[]; stdin: string }> = []
    const link = await mintPairingLink({ destination: 'j@h' }, 'desktop mac', scriptedSpawn([{ stdout: '{"url":"u","code":"c","expiresAt":1}\n' }], seen))
    expect(link.code).toBe('c')
    const command = seen[0].args.at(-1) ?? ''
    expect(command).toContain('studio pair --json')
    expect(command).toContain(`--label 'desktop mac'`)
    expect(command).toContain(`--scopes ${SSH_DOOR_SCOPES.join(',')}`)
    expect(SSH_DOOR_SCOPES).toContain('admin')
  })
})
