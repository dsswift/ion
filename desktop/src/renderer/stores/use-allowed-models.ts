import { useEffect, useState } from 'react'
import { usePreferencesStore } from '../preferences'
import { getFilteredModels, type AvailableModel } from '@ion/server/store/model-labels'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { activeTabEnvironmentId } from '../studio/connection/tab-environment'
import { policyStore } from '../studio/connection/policy-store'

/**
 * Reactive hook: the model list filtered by the enterprise policy of ONE
 * environment (D-011, spec 14). Defaults to the local environment, whose
 * policy also drives `usePreferencesStore().enterprisePolicy` (the legacy,
 * single-engine path every existing call site still reads through) — an
 * explicit `environmentId` reads a REMOTE environment's own policy from the
 * connection policy store instead, so a tab's model picker only ever
 * narrows against the environment that tab actually runs on (spec 14
 * pinned behavior: "a remote allowedModels does not narrow a local tab" and
 * vice versa).
 */
export function useAllowedModels(environmentId: string = activeTabEnvironmentId()): readonly AvailableModel[] {
  const localAllowedModels = usePreferencesStore((s) => s.enterprisePolicy?.allowedModels)
  const [policyVersion, setPolicyVersion] = useState(0)
  useEffect(() => policyStore.subscribe(() => setPolicyVersion((v) => v + 1)), [])
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    return getFilteredModels(localAllowedModels)
  }
  // policyVersion is a cheap change signal only; reading it here (rather
  // than in a dependency array) keeps this hook's shape a plain function of
  // its arguments, matching the local branch above.
  void policyVersion
  const remotePolicy = policyStore.environmentPolicy(environmentId)
  return getFilteredModels(remotePolicy?.allowedModels)
}
