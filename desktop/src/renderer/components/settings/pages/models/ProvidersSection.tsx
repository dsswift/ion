/**
 * ProvidersSection — the model providers of the server this page is about:
 * one row per provider with how it is signed in, configured ones first.
 * Keys, sign-ins, and model refreshes all happen in the provider's side
 * panel and go to that server, so a remote host gets its API keys from here
 * instead of from a copied laptop config.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getProviderDisplayName, type ProviderEntry } from '@ion/shared/types-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { useSettingsEnvironment } from '../../settings-servers'
import { useEnvironmentEnterprisePolicy } from '../../use-environment-enterprise-policy'
import { authSourceTooltip, providerAuthBadge } from '../../provider-auth-labels'
import { providerOverrides, removedProviders } from '../../policy-override-notices'
import { CellText, Chip, DataList, EmptyState, Notice, StatusDot } from '../../kit'
import { rWarn } from '../../../../rendererLogger'
import { ProviderPanel } from './ProviderPanel'

export function ProvidersSection(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const fetchModelsFor = useModelStore((s) => s.fetchModelsFor)
  const providers = useModelStore((s) => environmentModels(s, env.id).providers)
  const loading = useModelStore((s) => environmentModels(s, env.id).loading)
  // That server's own provider allowlist narrows the list, not this device's.
  const policy = useEnvironmentEnterprisePolicy(env.id)
  const allowedProviders = policy?.allowedProviders
  const removed = removedProviders(policy)
  const [openId, setOpenId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const allowed = allowedProviders && allowedProviders.length > 0 ? new Set(allowedProviders) : null
    const shown = allowed ? providers.filter((p) => allowed.has(p.id)) : providers
    return [...shown.filter((p) => p.hasAuth), ...shown.filter((p) => !p.hasAuth)]
  }, [providers, allowedProviders])

  const refetchModels = useCallback(() => {
    void fetchModelsFor(env.id).catch((err: unknown) => rWarn('settings', 'fetch models failed', { environment_id: env.id, error: String(err) }))
  }, [fetchModelsFor, env.id])

  useEffect(() => { refetchModels() }, [refetchModels])

  // The panel reads the live entry, so a sign-in finishing updates it in place.
  const open = openId ? visible.find((p) => p.id === openId) : undefined

  return (
    <>
      {removed.length > 0 && (
        <Notice tone="warn">
          Your organization does not allow {removed.length === 1 ? 'this provider' : 'these providers'}, so {removed.length === 1 ? 'its' : 'their'} configuration on {env.label} is not in effect: {removed.join(', ')}.
        </Notice>
      )}
      <DataList<ProviderEntry>
        label="Providers"
        title="Providers"
        description={`Keys and sign-ins ${env.label} uses to reach model providers.`}
        anchor="providers"
        items={visible}
        loading={loading}
        getKey={(p) => p.id}
        noun={['provider', 'providers']}
        filter={(p, q) => p.id.toLowerCase().includes(q) || getProviderDisplayName(p.id, providers).toLowerCase().includes(q)}
        onRowClick={(p) => setOpenId(p.id)}
        showHeader
        columns={[
          { id: 'name', header: 'Provider', render: (p) => <CellText>{getProviderDisplayName(p.id, providers)}</CellText> },
          { id: 'gateway', width: 'auto', render: (p) => (p.baseURL ? <Chip tone="warn">custom gateway</Chip> : null) },
          { id: 'managed', width: 'auto', render: (p) => (providerOverrides(policy, p.id).length > 0 ? <Chip tone="accent">managed</Chip> : null) },
          {
            id: 'auth', header: 'Sign-in', width: '220px',
            render: (p) => <><StatusDot tone={p.hasAuth ? 'ok' : 'muted'} label={p.hasAuth ? authSourceTooltip(p.authSource) : undefined} /><CellText muted={!p.hasAuth}>{providerAuthBadge(p)}</CellText></>,
          },
        ]}
        empty={(
          <EmptyState
            title="No providers"
            detail={env.isLocal
              ? 'No providers available. Start the engine to see providers.'
              : 'No providers reported. The environment may be offline, or this device may not be an admin of it.'}
          />
        )}
      />
      {open && <ProviderPanel key={`${env.id}:${open.id}`} provider={open} environmentId={env.id} onClose={() => setOpenId(null)} onCredentialSaved={refetchModels} />}
    </>
  )
}
