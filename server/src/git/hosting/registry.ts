/**
 * Which git hosts this server can manage repositories on, and the provider
 * for each: the well-known hosts every provider serves, the self-managed
 * ones `server.json.git.hosts` names, and the GitLab instance the sign-in
 * exchange is configured for.
 */
import type { GitHostingProviderKind } from '@ion/shared/types-git-hosting'
import { currentServerConfig } from '../../config/current'
import type { GitHostingProvider, GitHostingTarget } from './types'
import { githubProvider } from './providers/github'
import { gitlabProvider } from './providers/gitlab'
import { azureDevopsProvider } from './providers/azure-devops'

/** Every provider, keyed by kind. A new kind of host is added here. */
export const GIT_HOSTING_PROVIDERS: Record<GitHostingProviderKind, GitHostingProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  'azure-devops': azureDevopsProvider,
}

export function isGitHostingProviderKind(value: unknown): value is GitHostingProviderKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GIT_HOSTING_PROVIDERS, value)
}

const WELL_KNOWN_HOSTS: ReadonlyArray<{ host: string; provider: GitHostingProviderKind }> = [
  { host: 'github.com', provider: 'github' },
  { host: 'gitlab.com', provider: 'gitlab' },
  { host: 'dev.azure.com', provider: 'azure-devops' },
]

export interface GitHostingHost extends GitHostingTarget {
  provider: GitHostingProvider
}

/** Every host this server can manage repositories on. A configured host replaces a well-known one of the same name. */
export function gitHostingHosts(): GitHostingHost[] {
  const git = currentServerConfig().git
  const byHost = new Map<string, GitHostingHost>()
  const add = (host: string, kind: GitHostingProviderKind, apiBaseUrl?: string): void => {
    const provider = GIT_HOSTING_PROVIDERS[kind]
    byHost.set(host, { host, provider, apiBaseUrl: (apiBaseUrl || provider.defaultApiBaseUrl(host)).replace(/\/+$/, '') })
  }
  for (const known of WELL_KNOWN_HOSTS) add(known.host, known.provider)
  if (git.exchange.gitlab) add(new URL(git.exchange.gitlab.baseUrl).host, 'gitlab')
  for (const configured of git.hosts) add(configured.host, configured.provider, configured.apiBaseUrl)
  return [...byHost.values()]
}

export function gitHostingHostFor(host: string): GitHostingHost | null {
  return gitHostingHosts().find((h) => h.host === host) ?? null
}
