import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rInfo, rWarn } from '../../rendererLogger'
import { useColors } from '../../theme'
import { useModelStore } from '../../stores/model-store'
import { getProviderDisplayName } from '../../../shared/types-models'
import { SettingSection } from './SettingSection'

/**
 * Operator control for the engine's default provider — the provider a BARE
 * (unqualified) model name in ~/.ion/models.json resolves to. Seeds from
 * get_default_provider on mount and stays live on the engine's
 * engine_default_provider broadcast, mirroring ModelTiersSection's snapshot
 * pattern: the broadcast is a reload trigger, never a payload we merge.
 */
export function DefaultProviderSection() {
  const colors = useColors()
  const providers = useModelStore((state) => state.providers)
  const [provider, setProvider] = useState('')
  const [loading, setLoading] = useState(true)
  const readingRef = useRef(false)

  const authedProviders = useMemo(
    () => providers.filter((entry) => entry.hasAuth),
    [providers],
  )

  const load = useCallback(async () => {
    if (readingRef.current) return
    readingRef.current = true
    try {
      const next = await window.ion.getDefaultProvider()
      setProvider(next)
      rInfo('default-provider', 'default provider snapshot loaded', { provider: next, configured: next !== '' })
    } catch (err) {
      rWarn('default-provider', 'default provider snapshot load failed', { error: String(err) })
    } finally {
      readingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.ion.onDefaultProviderUpdated(() => {
      // get_default_provider itself emits the snapshot it returns, so a reload
      // triggered by our own read would recurse. Mutations and other clients
      // still deliver authoritative snapshots here.
      if (!readingRef.current) void load()
    })
  }, [load])

  const choose = useCallback((next: string) => {
    const previous = provider
    setProvider(next)
    void window.ion.setDefaultProvider(next).then((result) => {
      if (!result.ok) throw new Error(result.error || 'Could not save the default provider')
      rInfo('default-provider', 'default provider saved', { provider: next, cleared: next === '' })
    }).catch((err) => {
      setProvider(previous)
      rWarn('default-provider', 'default provider save failed', { provider: next, error: String(err) })
    })
  }, [provider])

  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 6px',
    background: colors.surfacePrimary,
    color: colors.textPrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 5,
    fontSize: 12,
  }

  // A preference pointing at a provider that is not currently authed stays
  // selectable: the engine still honours it, and silently dropping it from the
  // list would make the control misreport the persisted value.
  const options = authedProviders.some((entry) => entry.id === provider) || provider === ''
    ? authedProviders.map((entry) => ({ id: entry.id, label: getProviderDisplayName(entry.id, providers) }))
    : [...authedProviders.map((entry) => ({ id: entry.id, label: getProviderDisplayName(entry.id, providers) })),
      { id: provider, label: `${getProviderDisplayName(provider, providers)} (unavailable)` }]

  return (
    <SettingSection
      label="Default Provider"
      description="Prefer this provider when a model name doesn’t specify one. An explicitly qualified model (e.g. dci-marketing/claude-sonnet-5) always uses its own provider regardless of this setting."
    >
      {loading ? <span style={{ color: colors.textTertiary, fontSize: 12 }}>Loading default provider…</span> : (
        <select
          aria-label="Default provider"
          value={provider}
          onChange={(event) => choose(event.target.value)}
          style={selectStyle}
        >
          <option value="">No preference</option>
          {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      )}
    </SettingSection>
  )
}
