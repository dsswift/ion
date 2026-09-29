/**
 * FR-04: `runGit`'s automatic per-principal env merge. Separate from a
 * hypothetical `git-runner.test.ts` (none exists yet) because this pins one
 * specific, new behavior end to end: author identity and (for a network
 * subcommand) a resolved credential reach the actual git subprocess when an
 * ambient principal is present, and neither one appears when it is absent --
 * the historical single-owner-desktop behavior must stay byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { runAsPrincipal } from '../../identity/request-principal'
import { runGit } from '../git-runner'
import { _resetRemoteHostCacheForTest } from '../identity/remote-host'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../config/current'
import { loadServerConfig } from '../../config/server-config'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../identity/credential-store'
import { _resetResolverSourcesForTest } from '../identity/resolver'
import { gitMaterializeDir } from '../identity/materialize'

let dir: string
let dataDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-runner-principal-env-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'local@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Local User'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/org/repo.git'], { cwd: dir })

  previousDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-git-runner-principal-env-data-'))
  process.env.ION_DATA_DIR = dataDir

  _resetGitCredentialStoreForTest(dataDir)
  _resetResolverSourcesForTest()
  _resetRemoteHostCacheForTest()
  setCurrentServerConfig(loadServerConfig(dataDir))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = previousDataDir
  _resetCurrentServerConfigForTest()
})

describe('runGit: no ambient principal', () => {
  it('leaves an unattributed commit authored by the process git identity, unchanged from today', async () => {
    execFileSync('touch', ['file.txt'], { cwd: dir })
    await runGit(dir, ['add', 'file.txt'])
    await runGit(dir, ['commit', '-m', 'unattributed'])
    const author = (await runGit(dir, ['log', '-1', '--format=%an <%ae>'])).trim()
    expect(author).toBe('Local User <local@example.com>')
  })
})

describe('runGit: with an ambient principal', () => {
  it('stamps GIT_AUTHOR_*/GIT_COMMITTER_* from the principal onto a commit', async () => {
    execFileSync('touch', ['file.txt'], { cwd: dir })
    await runAsPrincipal({ principal: { subject: 'oidc:alice', displayName: 'Alice Example', email: 'alice@example.com' } }, async () => {
      await runGit(dir, ['add', 'file.txt'])
      await runGit(dir, ['commit', '-m', 'attributed'])
    })
    const author = (await runGit(dir, ['log', '-1', '--format=%an <%ae>'])).trim()
    expect(author).toBe('Alice Example <alice@example.com>')
  })

  it('does not stamp author env when the principal has no email', async () => {
    execFileSync('touch', ['file2.txt'], { cwd: dir })
    await runAsPrincipal({ principal: { subject: 'oidc:alice', displayName: 'Alice Example' } }, async () => {
      await runGit(dir, ['add', 'file2.txt'])
      await runGit(dir, ['commit', '-m', 'no-email'])
    })
    const author = (await runGit(dir, ['log', '-1', '--format=%an <%ae>'])).trim()
    expect(author).toBe('Local User <local@example.com>')
  })

  it('resolves and materializes a credential for a network subcommand before the subprocess runs', async () => {
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'ssh', privateKey: 'FAKE-KEY-MATERIAL', publicKey: 'ssh-ed25519 AAAA' })

    await runAsPrincipal({ principal: { subject: 'oidc:alice', displayName: 'Alice Example', email: 'alice@example.com' } }, async () => {
      // `git ls-remote` against a fake host fails (no such host reachable),
      // which is expected: this pins that materializeGitCredential ran
      // BEFORE the subprocess spawned, not that the network call succeeds.
      await runGit(dir, ['ls-remote']).catch(() => undefined)
    })

    const keyPath = join(gitMaterializeDir('oidc:alice', 'gitlab.example.com'), 'id_key')
    expect(readFileSync(keyPath, 'utf-8')).toBe('FAKE-KEY-MATERIAL\n')
  })

  it('never materializes a credential for a non-network subcommand', async () => {
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'ssh', privateKey: 'FAKE-KEY-MATERIAL', publicKey: 'ssh-ed25519 AAAA' })
    execFileSync('touch', ['file3.txt'], { cwd: dir })

    await runAsPrincipal({ principal: { subject: 'oidc:alice', displayName: 'Alice Example', email: 'alice@example.com' } }, async () => {
      await runGit(dir, ['add', 'file3.txt'])
      await runGit(dir, ['commit', '-m', 'no network here'])
    })

    expect(existsSync(join(gitMaterializeDir('oidc:alice', 'gitlab.example.com'), 'id_key'))).toBe(false)
  })
})
