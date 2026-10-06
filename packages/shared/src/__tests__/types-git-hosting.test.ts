import { describe, expect, it } from 'vitest'
import { repositoryNameProblem, type GitHostingAccount, type GitHostingRepository } from '../types-git-hosting'
import { gitIdentityKey, type GitIdentitySummary } from '../types-git-identity'

describe('repositoryNameProblem', () => {
  it('accepts the names every supported host accepts', () => {
    for (const name of ['app', 'my-project', 'ion.studio', 'a_b', '2fa']) expect(repositoryNameProblem(name)).toBeNull()
  })

  it('refuses an empty name, spaces, a leading dash, and a .git or dot ending', () => {
    for (const name of ['', 'my app', '-app', 'org/app', 'app.git', 'app.']) expect(repositoryNameProblem(name)).not.toBeNull()
  })
})

describe('git hosting wire shapes', () => {
  it('survive a JSON round trip unchanged', () => {
    const account: GitHostingAccount = {
      host: 'github.com', provider: 'github', account: 'example-user', credentialSource: 'host', choosesVisibility: true,
      owners: [{ id: 'user:example-user', label: 'example-user', kind: 'user' }, { id: 'org:example-org', label: 'example-org', kind: 'org' }],
    }
    const repository: GitHostingRepository = {
      host: 'github.com', provider: 'github', owner: 'example-org', name: 'app', webUrl: 'https://github.com/example-org/app',
      sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git', defaultBranch: 'main',
    }
    expect(JSON.parse(JSON.stringify(account))).toEqual(account)
    expect(JSON.parse(JSON.stringify(repository))).toEqual(repository)
  })
})

describe('gitIdentityKey', () => {
  it('tells apart the rows one host can carry', () => {
    const rows: GitIdentitySummary[] = [
      { host: '*', source: 'host', kind: 'ssh', file: 'id_ed25519.pub' },
      { host: '*', source: 'host', kind: 'ssh', file: 'id_rsa.pub' },
      { host: 'github.com', source: 'host', kind: 'https-token', tool: 'gh' },
      { host: 'github.com', source: 'user', kind: 'ssh' },
    ]
    expect(new Set(rows.map(gitIdentityKey)).size).toBe(4)
  })
})
