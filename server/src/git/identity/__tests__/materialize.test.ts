import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gitMaterializeDir, materializeGitCredential } from '../materialize'

let previousDataDir: string | undefined

beforeEach(() => {
  previousDataDir = process.env.ION_DATA_DIR
  process.env.ION_DATA_DIR = mkdtempSync(join(tmpdir(), 'ion-git-materialize-test-'))
})

afterEach(() => {
  rmSync(process.env.ION_DATA_DIR!, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = previousDataDir
})

describe('materializeGitCredential: ssh', () => {
  it('writes the private key at 0600 and returns a GIT_SSH_COMMAND pointing at it', async () => {
    const env = await materializeGitCredential('oidc:alice', { source: 'user', kind: 'ssh', host: 'github.com', privateKey: 'KEY-MATERIAL' })
    const dir = gitMaterializeDir('oidc:alice', 'github.com')
    const keyPath = join(dir, 'id_key')

    expect(readFileSync(keyPath, 'utf-8')).toBe('KEY-MATERIAL\n')
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(env.GIT_SSH_COMMAND).toContain(keyPath)
    expect(env.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes')
  })

  it('two subjects materialize into two distinct directories', async () => {
    await materializeGitCredential('oidc:alice', { source: 'user', kind: 'ssh', host: 'github.com', privateKey: 'ALICE-KEY' })
    await materializeGitCredential('oidc:bob', { source: 'user', kind: 'ssh', host: 'github.com', privateKey: 'BOB-KEY' })
    expect(gitMaterializeDir('oidc:alice', 'github.com')).not.toBe(gitMaterializeDir('oidc:bob', 'github.com'))
    expect(readFileSync(join(gitMaterializeDir('oidc:alice', 'github.com'), 'id_key'), 'utf-8')).toBe('ALICE-KEY\n')
    expect(readFileSync(join(gitMaterializeDir('oidc:bob', 'github.com'), 'id_key'), 'utf-8')).toBe('BOB-KEY\n')
  })
})

describe('materializeGitCredential: https-token', () => {
  it('writes an executable askpass script that answers Username/Password prompts', async () => {
    const env = await materializeGitCredential('oidc:alice', { source: 'user', kind: 'https-token', host: 'gitlab.example.com', token: 'glpat-secret', username: 'alice' })
    const dir = gitMaterializeDir('oidc:alice', 'gitlab.example.com')
    const askpassPath = join(dir, 'askpass.sh')

    expect(statSync(askpassPath).mode & 0o777).toBe(0o700)
    expect(env.GIT_ASKPASS).toBe(askpassPath)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')

    const script = readFileSync(askpassPath, 'utf-8')
    expect(script).toContain('glpat-secret')
    expect(script).toContain('alice')
  })

  it('defaults the askpass username to oauth2 when none is supplied', async () => {
    const dir = gitMaterializeDir('oidc:alice', 'gitlab.example.com')
    await materializeGitCredential('oidc:alice', { source: 'exchange-gitlab', kind: 'https-token', host: 'gitlab.example.com', token: 't' })
    expect(readFileSync(join(dir, 'askpass.sh'), 'utf-8')).toContain('oauth2')
  })
})
