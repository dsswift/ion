/**
 * The `admin` unified credential source (FR-05 child 09, highest resolver
 * precedence): operator-managed entries under `server.json.providerCredentials[]`
 * (model-provider axis) and `server.json.git.credentials[]` (git axis, the
 * existing FR-04 shape, folded in here rather than duplicated). Read-only
 * from the server's perspective -- an operator edits `server.json` (or the
 * `secretstore:` values it references) directly; there is no action that
 * mutates either list, matching `git/identity/sources/admin-refs.ts`'s
 * existing precedent exactly.
 */
import type {
  PrincipalCredentialScope,
  PrincipalCredentialSource,
  ResolvedPrincipalCredential,
} from '../principal-source'
import type { ServerGitCredentialConfig, ServerProviderCredentialConfig } from '../../config/server-config'

/** The `admin` source for the unified resolver: consulted first, before any exchange or user-supplied credential. */
export function adminRefsSource(
  getProviderCredentials: () => ServerProviderCredentialConfig[],
  getGitCredentials: () => ServerGitCredentialConfig[],
): PrincipalCredentialSource {
  return {
    name: 'admin',
    resolve: (scope: PrincipalCredentialScope): ResolvedPrincipalCredential | null => {
      const axis = scope.axis
      if (axis.kind === 'provider') {
        const entry = getProviderCredentials().find(
          (c) => c.subject === scope.subject && c.provider === axis.provider,
        )
        if (!entry) return null
        return { source: 'admin', value: { kind: 'provider', token: entry.value, header: entry.header } }
      }

      const entry = getGitCredentials().find((c) => c.subject === scope.subject && c.host === axis.host)
      if (!entry) return null
      if (entry.kind === 'ssh') {
        if (!entry.privateKey) return null
        return {
          source: 'admin',
          value: {
            kind: 'git',
            cred: { source: 'admin', kind: 'ssh', host: entry.host, privateKey: entry.privateKey, publicKey: entry.publicKey },
          },
        }
      }
      if (!entry.token) return null
      return {
        source: 'admin',
        value: {
          kind: 'git',
          cred: { source: 'admin', kind: 'https-token', host: entry.host, token: entry.token, username: entry.username },
        },
      }
    },
  }
}
