/**
 * The enterprise policy as one principal sees it.
 *
 * The cached policy (`enterprise-policy-publish.ts`) is the one the engine
 * process runs under. A machine policy can also scope policy to principals,
 * and the engine resolves that per principal on request. Everything here
 * asks the engine for a named principal and keeps the answer under that
 * principal's own subject, so one person's policy is never read for another.
 */
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import type { EnterprisePolicy, SessionPrincipal } from '@ion/shared/types-engine'
import { getEnterprisePolicy } from './engine/engine-bridge-fs'
import { onEnterprisePolicyChange, settledEnterprisePolicy } from './enterprise-policy-publish'
import { lookupClaims, lookupPrincipal } from './identity/principal-registry'
import { toSessionPrincipal } from './identity/session-principal'
import { log, warn } from './logger'

/** The engine-wire principal for a registered subject, or undefined when the subject is unknown. */
export function sessionPrincipalForSubject(subject: string): SessionPrincipal | undefined {
  const principal = lookupPrincipal(subject)
  return principal ? toSessionPrincipal(principal, lookupClaims(subject)) : undefined
}

/**
 * The policy that applies to `principal`. Waits for the server's first policy
 * read, so a caller never sees "no policy" merely because it has not loaded.
 * With no enterprise policy at all there is nothing to scope, and when the
 * engine cannot answer, the process policy stands in.
 */
export async function enterprisePolicyFor(
  principal: StudioPrincipalSummary,
  claims: Record<string, unknown> | undefined = lookupClaims(principal.subject),
): Promise<EnterprisePolicy | null> {
  const processPolicy = await settledEnterprisePolicy()
  if (processPolicy === null) return null
  try {
    const policy = await getEnterprisePolicy(toSessionPrincipal(principal, claims))
    if (policy !== null) return policy
    warn('enterprise-policy', 'per-principal policy read returned nothing; using the process policy', { subject: principal.subject })
  } catch (err) {
    warn('enterprise-policy', 'per-principal policy read failed; using the process policy', { subject: principal.subject, error: String(err) })
  }
  return processPolicy
}

type NewConversationDefaults = { baseDirectory: string; engineProfileId: string; locked: boolean } | null

const defaultsBySubject = new Map<string, NewConversationDefaults>()

/** Records the new-conversation defaults resolved for one subject. */
export function rememberNewConversationDefaults(subject: string, defaults: NewConversationDefaults): void {
  defaultsBySubject.set(subject, defaults)
}

/** The defaults last resolved for `subject`, or undefined when none were. */
export function newConversationDefaultsFor(subject: string): NewConversationDefaults | undefined {
  return defaultsBySubject.get(subject)
}

onEnterprisePolicyChange(() => {
  log('enterprise-policy', 'enterprise policy changed; dropping per-principal defaults', { subjects: defaultsBySubject.size })
  defaultsBySubject.clear()
})
