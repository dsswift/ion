import React, { useEffect } from 'react'
import { useColors } from '../../theme'
import { SettingHeading } from './SettingHeading'
import { useModelStore } from '../../stores/model-store'
import { ProviderRow } from './ProviderRow'

export function ProvidersCategory() {
  const colors = useColors()
  const fetchModels = useModelStore((s) => s.fetchModels)
  const providers = useModelStore((s) => s.providers)
  const loading = useModelStore((s) => s.loading)

  useEffect(() => { fetchModels() }, [fetchModels])

  return (
    <>
      <SettingHeading first>Providers</SettingHeading>
      {loading && providers.length === 0 && (
        <div style={{ padding: '12px 0', fontSize: 12, color: colors.textTertiary }}>Loading providers…</div>
      )}
      {providers.map((p) => (
        <ProviderRow key={p.id} provider={p} colors={colors} onCredentialSaved={fetchModels} />
      ))}
      {providers.length === 0 && !loading && (
        <div style={{ padding: '12px 0', fontSize: 12, color: colors.textTertiary }}>
          No providers available. Start the engine to see providers.
        </div>
      )}
    </>
  )
}
