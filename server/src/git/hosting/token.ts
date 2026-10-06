/**
 * The token a person's hosting calls present: the first `https-token`
 * credential the git identity resolver has for the host, which is one Ion
 * stores when there is one and the host's signed-in CLI otherwise. An SSH
 * key cannot call an API, so it is passed over.
 */
import { resolveGitCredential } from '../identity/resolver'
import type { GitHostingAuth } from './types'

export async function hostingToken(subject: string, host: string): Promise<GitHostingAuth | null> {
  const cred = await resolveGitCredential(subject, host, { kind: 'https-token' })
  return cred?.token ? { token: cred.token, source: cred.source } : null
}
