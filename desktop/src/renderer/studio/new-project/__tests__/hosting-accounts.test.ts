/** hosting-accounts — one choice per account across the fleet, and which server creates for an owner. */
import { describe, expect, it, vi } from 'vitest'
import type { GitHostingAccount } from '@ion/shared/types-git-hosting'

vi.mock('../../../host/host-instance', () => ({ host: { onFrame: () => () => {} }, action: vi.fn() }))
vi.mock('../../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))

const { mergeHostingAccounts, creatingEnvironment } = await import('../hosting-accounts')

const github = (owners: GitHostingAccount['owners'], extra: Partial<GitHostingAccount> = {}): GitHostingAccount => ({ host: 'github.com', provider: 'github', account: 'example-user', credentialSource: 'host', choosesVisibility: true, owners, ...extra })
const me = { id: 'user:example-user', label: 'example-user', kind: 'user' as const }
const org = { id: 'org:example-org', label: 'example-org', kind: 'org' as const }
const other = { id: 'org:other-org', label: 'other-org', kind: 'org' as const }

describe('mergeHostingAccounts', () => {
  it('folds the same account seen from two servers into one choice, and remembers who can create where', () => {
    const merged = mergeHostingAccounts([
      { environmentId: 'devbox', accounts: [github([me, org, other])] },
      { environmentId: 'local', accounts: [github([me, org])] },
    ])
    expect(merged.problems).toEqual([])
    expect(merged.accounts).toHaveLength(1)
    expect(merged.accounts[0].owners.map((o) => [o.id, o.environments])).toEqual([
      ['user:example-user', ['devbox', 'local']],
      ['org:example-org', ['devbox', 'local']],
      ['org:other-org', ['devbox']],
    ])
  })

  it('keeps two accounts on one host apart', () => {
    const merged = mergeHostingAccounts([
      { environmentId: 'local', accounts: [github([me])] },
      { environmentId: 'devbox', accounts: [github([{ id: 'user:work-user', label: 'work-user', kind: 'user' }], { account: 'work-user' })] },
    ])
    expect(merged.accounts.map((a) => a.key)).toEqual(['github.com|example-user', 'github.com|work-user'])
  })

  it('reports a refused host as a problem and offers no choice for it', () => {
    const merged = mergeHostingAccounts([{ environmentId: 'devbox', accounts: [github([], { account: '', error: 'Bad credentials' })] }])
    expect(merged.accounts).toEqual([])
    expect(merged.problems).toEqual([{ environmentId: 'devbox', host: 'github.com', error: 'Bad credentials' }])
  })
})

describe('creatingEnvironment', () => {
  it('prefers this machine, else the first server that can create there', () => {
    expect(creatingEnvironment({ ...org, environments: ['devbox', 'local'] })).toBe('local')
    expect(creatingEnvironment({ ...other, environments: ['devbox', 'buildbox'] })).toBe('devbox')
  })
})
