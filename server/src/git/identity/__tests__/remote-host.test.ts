import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { remoteForGitInvocation, hostFromUrl, _resetRemoteHostCacheForTest } from '../remote-host'

describe('hostFromUrl', () => {
  it('extracts the host from an https URL', () => {
    expect(hostFromUrl('https://github.com/org/repo.git')).toBe('github.com')
  })

  it('extracts the host from an ssh:// URL', () => {
    expect(hostFromUrl('ssh://git@gitlab.example.com:2222/org/repo.git')).toBe('gitlab.example.com')
  })

  it('extracts the host from the git@host:path SCP shorthand', () => {
    expect(hostFromUrl('git@github.com:org/repo.git')).toBe('github.com')
  })

  it('returns null for a token that is not a remote URL', () => {
    expect(hostFromUrl('origin')).toBeNull()
    expect(hostFromUrl('main')).toBeNull()
  })
})

describe('remoteForGitInvocation', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-remote-host-test-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: dir })
    _resetRemoteHostCacheForTest()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves the configured origin remote when no remote name is given', async () => {
    expect((await remoteForGitInvocation(dir, ['push']))?.host).toBe('github.com')
  })

  it('resolves a named remote', async () => {
    execFileSync('git', ['remote', 'add', 'upstream', 'git@gitlab.example.com:org/repo.git'], { cwd: dir })
    expect((await remoteForGitInvocation(dir, ['fetch', 'upstream']))?.host).toBe('gitlab.example.com')
  })

  it('extracts the host directly from an explicit URL argument', async () => {
    expect((await remoteForGitInvocation(dir, ['ls-remote', 'https://gitlab.example.com/org/repo.git']))?.host).toBe('gitlab.example.com')
  })

  it('returns null for clone with no URL findable in args', async () => {
    expect(await remoteForGitInvocation(dir, ['clone'])).toBeNull()
  })

  it('resolves clone from its URL argument', async () => {
    expect((await remoteForGitInvocation(dir, ['clone', 'https://github.com/example/other.git', 'dest']))?.host).toBe('github.com')
  })

  it('returns null for a remote name that does not exist', async () => {
    expect(await remoteForGitInvocation(dir, ['push', 'no-such-remote'])).toBeNull()
  })

  it('skips leading flags when finding the subcommand and operands', async () => {
    expect((await remoteForGitInvocation(dir, ['-c', 'foo=bar', 'push']))?.host).toBe('github.com')
  })
})
