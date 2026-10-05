/**
 * SwitchAccountPanel — the provider CLI accounts of one server, opened from
 * the Fleet: each provider that signs in through a CLI, with the account it
 * is on and the sign-in that puts another account in its place. Everything
 * runs on that server, through its own provider CLI.
 */
import React, { useEffect, useMemo } from 'react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useEnvironmentEnterprisePolicy } from '../../use-environment-enterprise-policy'
import { providerCliBackend } from '../../provider-auth-labels'
import { Button, EmptyState, Muted, SidePanel, Stack } from '../../kit'
import { ProviderCliSignIn } from '../models/ProviderCliSignIn'

export function SwitchAccountPanel({ entry, onClose }: { entry: EnvironmentCatalogEntry | null; onClose(): void }): React.JSX.Element | null {
  return entry ? <SwitchAccountFlow key={entry.id} entry={entry} onClose={onClose} /> : null
}

function SwitchAccountFlow({ entry, onClose }: { entry: EnvironmentCatalogEntry; onClose(): void }): React.JSX.Element {
  const fetchModelsFor = useModelStore((s) => s.fetchModelsFor)
  const providers = useModelStore((s) => environmentModels(s, entry.id).providers)
  const loading = useModelStore((s) => environmentModels(s, entry.id).loading)
  // That server's own provider allowlist narrows the list, not this device's.
  const allowedProviders = useEnvironmentEnterprisePolicy(entry.id)?.allowedProviders

  useEffect(() => {
    rInfo('settings.fleet', 'switch account opened', { environment_id: entry.id })
    void fetchModelsFor(entry.id).catch((err: unknown) => rWarn('settings.fleet', 'fetch models failed', { environment_id: entry.id, error: String(err) }))
  }, [fetchModelsFor, entry.id])

  const withCli = useMemo(() => {
    const allowed = allowedProviders && allowedProviders.length > 0 ? new Set(allowedProviders) : null
    return providers.filter((p) => providerCliBackend(p.id) !== undefined && (!allowed || allowed.has(p.id)))
  }, [providers, allowedProviders])

  return (
    <SidePanel
      open
      title={`Accounts on ${entry.label}`}
      subtitle={`Each provider CLI on ${entry.label} and the account it is signed in to. Switch account signs in to another one; the current account stays until the new sign-in finishes.`}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {withCli.length === 0 ? (
        loading
          ? <Muted>Reading {entry.label}…</Muted>
          : <EmptyState title="No provider CLI here." detail={`${entry.label} reports no provider that signs in through a CLI.`} />
      ) : (
        <Stack gap={16}>
          {withCli.map((p) => <ProviderCliSignIn key={p.id} provider={p} environmentId={entry.id} title={getProviderDisplayName(p.id, providers)} />)}
        </Stack>
      )}
    </SidePanel>
  )
}
