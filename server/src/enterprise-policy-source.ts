/**
 * This Environment's enterprise policy, for the modules that must apply it
 * but must not import `state` (which constructs the engine bridge on import
 * and would drag it into every reader). `state.ts` registers the cache; the
 * source is read at call time so a policy that arrives after boot applies to
 * the next call.
 */
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

let source: () => EnterprisePolicy | null = () => null

export function registerEnterprisePolicySource(next: () => EnterprisePolicy | null): void {
  source = next
}

export function currentEnterprisePolicy(): EnterprisePolicy | null {
  return source()
}
