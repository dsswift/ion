/**
 * One server's enterprise policy, live. The local server's comes from the
 * app-wide preference store, which the boot fetch fills; another server's
 * comes from what it announced on its welcome (`policy-store`), which strips
 * the device-policy namespace so a remote server never shapes this device's
 * UI. Environment rules (models, seals) survive that strip.
 */
import { useEffect, useState } from 'react'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { usePreferencesStore } from '../../preferences'
import { policyStore } from '../../studio/connection/policy-store'

export function useEnvironmentEnterprisePolicy(environmentId: string): EnterprisePolicy | null {
  const local = usePreferencesStore((s) => s.enterprisePolicy)
  const [remote, setRemote] = useState<EnterprisePolicy | null>(() => policyStore.environmentPolicy(environmentId))
  useEffect(() => {
    setRemote(policyStore.environmentPolicy(environmentId))
    return policyStore.subscribe(() => setRemote(policyStore.environmentPolicy(environmentId)))
  }, [environmentId])
  return environmentId === LOCAL_ENVIRONMENT_ID ? local : remote
}
