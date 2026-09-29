/**
 * enterprise-lan-discovery — the enterprise seal on LAN discovery.
 *
 * LAN discovery lets a Studio Server announce itself on the local network
 * so a desktop can find it without a pasted link. It is off by default and
 * a person turns it on for a bounded window. An organization may not want
 * it on its network at all, so the enterprise policy can seal it:
 *
 *   customFields['ion-studio'].lanDiscovery = 'disabled'
 *
 * Sealed, a server never advertises (whatever its config or a client asks)
 * and a desktop neither offers the control nor browses for servers; pairing
 * then goes through a pairing link or another door. Absent or any other
 * value means allowed. One reader for both sides so the server's
 * enforcement and the desktop's UI can never disagree about the field.
 */
import type { EnterprisePolicy } from './types-enterprise'

export const ION_STUDIO_POLICY_NAMESPACE = 'ion-studio'

export function lanDiscoverySealed(policy: Pick<EnterprisePolicy, 'customFields'> | null | undefined): boolean {
  const fields = policy?.customFields?.[ION_STUDIO_POLICY_NAMESPACE]
  if (!fields || typeof fields !== 'object') return false
  return (fields as Record<string, unknown>).lanDiscovery === 'disabled'
}
