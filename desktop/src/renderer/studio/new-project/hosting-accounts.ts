/**
 * hosting-accounts — the git-host accounts the fleet can create a repository
 * as. Each connected server answers `gitHosting.accounts` for itself; the
 * same account seen from several servers is one choice, and every place it
 * can create in remembers which servers can do the creating.
 */
import { useCallback, useEffect, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { GitHostingAccount, GitHostingOwner, GitHostingProviderKind } from '@ion/shared/types-git-hosting'
import { environmentClient } from '../../components/settings/environment/environment-client'
import { rInfo, rWarn } from '../../rendererLogger'

const TAG = 'new-project.accounts'

/** Somewhere a repository can be created, and the servers holding a token that can create there. */
export interface HostingOwnerChoice extends GitHostingOwner {
  environments: string[]
}

/** One account on one git host, as the whole fleet sees it. */
export interface HostingAccountChoice {
  key: string
  host: string
  provider: GitHostingProviderKind
  account: string
  choosesVisibility: boolean
  owners: HostingOwnerChoice[]
}

/** A server whose token a git host refused, or that could not be asked. */
export interface HostingAccountProblem {
  environmentId: string
  /** Empty when the server itself could not be asked. */
  host: string
  error: string
}

export interface HostingAccounts {
  accounts: HostingAccountChoice[]
  problems: HostingAccountProblem[]
}

/** Folds each server's answer into one choice per `(host, account)`, in the order the servers were given. */
export function mergeHostingAccounts(answers: ReadonlyArray<{ environmentId: string; accounts: readonly GitHostingAccount[] }>): HostingAccounts {
  const byKey = new Map<string, HostingAccountChoice>()
  const problems: HostingAccountProblem[] = []
  for (const { environmentId, accounts } of answers) {
    for (const account of accounts) {
      if (account.error) problems.push({ environmentId, host: account.host, error: account.error })
      if (account.owners.length === 0) continue
      const key = `${account.host}|${account.account}`
      const choice = byKey.get(key) ?? { key, host: account.host, provider: account.provider, account: account.account, choosesVisibility: account.choosesVisibility, owners: [] }
      for (const owner of account.owners) {
        const held = choice.owners.find((o) => o.id === owner.id)
        if (held) held.environments.push(environmentId)
        else choice.owners.push({ ...owner, environments: [environmentId] })
      }
      byKey.set(key, choice)
    }
  }
  return { accounts: [...byKey.values()], problems }
}

/** The server that creates a repository for `owner`: this machine when it can, else the first server that can. */
export function creatingEnvironment(owner: HostingOwnerChoice): string {
  return owner.environments.includes(LOCAL_ENVIRONMENT_ID) ? LOCAL_ENVIRONMENT_ID : owner.environments[0]
}

/** Asks every given server for its accounts. `loading` holds until all have answered or failed. */
export function useHostingAccounts(environmentIds: readonly string[]): HostingAccounts & { loading: boolean; refresh(): void } {
  const [state, setState] = useState<HostingAccounts & { loading: boolean }>({ accounts: [], problems: [], loading: true })
  const [tick, setTick] = useState(0)
  const key = environmentIds.join('|')
  useEffect(() => {
    if (!key) { setState({ accounts: [], problems: [], loading: false }); return }
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true }))
    const unreachable: HostingAccountProblem[] = []
    void Promise.all(key.split('|').map(async (environmentId) => {
      try {
        return { environmentId, accounts: await environmentClient.hostingAccounts(environmentId) }
      } catch (err) {
        rWarn(TAG, 'accounts read failed', { environment_id: environmentId, error: String(err) })
        unreachable.push({ environmentId, host: '', error: err instanceof Error ? err.message : String(err) })
        return { environmentId, accounts: [] }
      }
    })).then((answers) => {
      if (cancelled) return
      const merged = mergeHostingAccounts(answers)
      rInfo(TAG, 'accounts read', { servers: answers.length, accounts: merged.accounts.length, problems: merged.problems.length + unreachable.length })
      setState({ accounts: merged.accounts, problems: [...merged.problems, ...unreachable], loading: false })
    })
    return () => { cancelled = true }
  }, [key, tick])
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, refresh }
}
