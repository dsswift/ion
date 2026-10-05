/**
 * CustomProvidersPanel — the custom providers of one server, opened from the
 * Fleet: each provider that exists only because that server's config defines
 * it, with its gateway and the removal that deletes it there.
 */
import React, { useCallback, useEffect, useMemo } from 'react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { Button, EmptyState, FormGroup, MonoLine, Muted, SidePanel, Stack } from '../../kit'
import { RemoveProviderRow } from '../models/RemoveProviderRow'

export function CustomProvidersPanel({ entry, onClose }: { entry: EnvironmentCatalogEntry | null; onClose(): void }): React.JSX.Element | null {
  return entry ? <CustomProvidersFlow key={entry.id} entry={entry} onClose={onClose} /> : null
}

function CustomProvidersFlow({ entry, onClose }: { entry: EnvironmentCatalogEntry; onClose(): void }): React.JSX.Element {
  const fetchModelsFor = useModelStore((s) => s.fetchModelsFor)
  const providers = useModelStore((s) => environmentModels(s, entry.id).providers)
  const loading = useModelStore((s) => environmentModels(s, entry.id).loading)

  const refetch = useCallback(() => {
    void fetchModelsFor(entry.id).catch((err: unknown) => rWarn('settings.fleet', 'fetch models failed', { environment_id: entry.id, error: String(err) }))
  }, [fetchModelsFor, entry.id])

  useEffect(() => {
    rInfo('settings.fleet', 'custom providers opened', { environment_id: entry.id })
    refetch()
  }, [refetch, entry.id])

  const custom = useMemo(() => providers.filter((p) => p.custom), [providers])

  return (
    <SidePanel
      open
      title={`Custom providers on ${entry.label}`}
      subtitle={`Providers ${entry.label}'s configuration defines, such as a company gateway. Built-in providers are set up from the server's Providers page.`}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {custom.length === 0 ? (
        loading
          ? <Muted>Reading {entry.label}…</Muted>
          : <EmptyState title="No custom providers." detail={`${entry.label} uses only built-in providers.`} />
      ) : (
        <Stack gap={16}>
          {custom.map((p) => {
            const name = getProviderDisplayName(p.id, providers)
            return (
              <FormGroup key={p.id} title={name}>
                {p.baseURL && <MonoLine>{p.baseURL}</MonoLine>}
                <RemoveProviderRow provider={p} name={name} environmentId={entry.id} serverLabel={entry.label} onRemoved={refetch} />
              </FormGroup>
            )
          })}
        </Stack>
      )}
    </SidePanel>
  )
}
