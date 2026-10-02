/**
 * What the engine's managed config projection means for this server's own
 * access to engine.json.
 */
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { ManagedEngineConfigSource } from './persistence/settings-store'

/**
 * The managed engine file named by a policy, or null when the policy declares
 * none. A declared file that the engine could not apply yields a source with
 * no path: the engine configuration is still managed, and it holds defaults.
 */
export function managedEngineConfigSource(policy: EnterprisePolicy | null): ManagedEngineConfigSource | null {
  const status = policy?.managedConfigStatus?.engine
  if (!status) return null
  const path = policy?.managedConfig?.enginePath
  return { path: status.projected && path ? path : null }
}
