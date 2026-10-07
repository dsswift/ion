/**
 * Whether this desktop may capture profiles: the `profiling` developer
 * surface of device policy (`customFields['ion-desktop'].developerSurfaces`),
 * read with the same rule as every other developer surface
 * (`@ion/shared/developer-surfaces`): on unless a policy says `"disabled"`.
 */
import { deriveDeviceDeveloperSurfaces } from '@ion/shared/developer-surfaces'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

export function profilingSurfaceEnabled(policy: EnterprisePolicy | null | undefined): boolean {
  return deriveDeviceDeveloperSurfaces(policy).profiling
}
