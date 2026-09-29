import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { resolveWorkspaceGitToolEnv } from '../workspace-tool-env'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../credential-store'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../../config/current'
import { loadServerConfig } from '../../../config/server-config'
import { _resetResolverSourcesForTest } from '../resolver'
import { _resetRemoteHostCacheForTest } from '../remote-host'

let repoDir: string
let dataDir: string

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'ion-workspace-tool-env-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.example.com:org/repo.git'], { cwd: repoDir })

  dataDir = mkdtempSync(join(tmpdir(), 'ion-workspace-tool-env-data-'))
  _resetGitCredentialStoreForTest(dataDir)
  _resetResolverSourcesForTest()
  _resetRemoteHostCacheForTest()
  setCurrentServerConfig(loadServerConfig(dataDir))
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  _resetCurrentServerConfigForTest()
})

describe('resolveWorkspaceGitToolEnv', () => {
  it('returns undefined for missing working directory or subject', async () => {
    expect(await resolveWorkspaceGitToolEnv(undefined, 'oidc:alice')).toBeUndefined()
    expect(await resolveWorkspaceGitToolEnv(repoDir, undefined)).toBeUndefined()
  })

  it('returns undefined when no credential resolves for the configured remote', async () => {
    expect(await resolveWorkspaceGitToolEnv(repoDir, 'oidc:alice')).toBeUndefined()
  })

  it('returns undefined for a directory with no git remote at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-workspace-tool-env-norepo-'))
    try {
      expect(await resolveWorkspaceGitToolEnv(dir, 'oidc:alice')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves and materializes the credential for the workspaces configured remote host', async () => {
    process.env.ION_DATA_DIR = dataDir
    try {
      gitCredentialStore().set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'ssh', privateKey: 'FAKE-KEY', publicKey: 'ssh-ed25519 AAAA' })
      const env = await resolveWorkspaceGitToolEnv(repoDir, 'oidc:alice')
      expect(env?.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes')
    } finally {
      delete process.env.ION_DATA_DIR
    }
  })
})
