import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, ShieldCheck, Trash } from '@phosphor-icons/react'
import { STANDARD_TIERS, WORKBENCH_SYNC_TIER, type ModelTier } from '../../../shared/types-model-tiers'
import { rInfo, rWarn } from '../../rendererLogger'
import { useColors } from '../../theme'
import { useModelStore } from '../../stores/model-store'
import { SettingSection } from './SettingSection'
import { Tooltip } from '../git/Tooltip'
import { groupModelChoices } from '../../../shared/model-identity'

const EMPTY_TIER: ModelTier = { name: '', model: '', fallbacks: [] }

export function ModelTiersSection() {
  const colors = useColors()
  const models = useModelStore((state) => state.models)
  const [tiers, setTiers] = useState<ModelTier[]>([])
  const [newTier, setNewTier] = useState(EMPTY_TIER)
  const [loading, setLoading] = useState(true)
  const listingRef = useRef(false)
  const displayTiers = useMemo(() => orderedTiers(tiers), [tiers])

  const load = useCallback(async () => {
    if (listingRef.current) return
    listingRef.current = true
    try {
      const next = await window.ion.listModelTiers()
      setTiers(next)
      rInfo('model-tiers', 'model tier snapshot loaded', { count: next.length })
    } catch (err) {
      rWarn('model-tiers', 'model tier snapshot load failed', { error: String(err) })
    } finally {
      listingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.ion.onModelTiersUpdated(() => {
      // list_model_tiers itself emits the snapshot it returns. Reloading from
      // that event would recursively issue another list request. Mutations and
      // external clients still deliver authoritative snapshots here directly.
      if (!listingRef.current) void load()
    })
  }, [load])

  const save = useCallback(async (tier: ModelTier) => {
    const result = await window.ion.setModelTier(tier)
    if (!result.ok) throw new Error(result.error || 'Could not save model tier')
    setTiers((current) => [...current.filter(({ name }) => name !== tier.name), tier].sort((a, b) => a.name.localeCompare(b.name)))
    rInfo('model-tiers', 'model tier saved', { tier: tier.name, model: tier.model, fallbackCount: tier.fallbacks.length })
  }, [])

  const updatePrimary = useCallback((tier: ModelTier, model: string) => {
    if (!model) return
    void save({ ...tier, model }).catch((err) => rWarn('model-tiers', 'primary model save failed', { tier: tier.name, error: String(err) }))
  }, [save])

  const updateFallback = useCallback((tier: ModelTier, fallback: string) => {
    // Desktop intentionally owns only index zero. The engine supports a full
    // chain; preserve its remaining entries verbatim so other consumers keep
    // their policy and a former second fallback becomes visible after removal.
    const fallbacks = fallback ? [fallback, ...tier.fallbacks.slice(1)] : tier.fallbacks.slice(1)
    void save({ ...tier, fallbacks }).catch((err) => rWarn('model-tiers', 'fallback model save failed', { tier: tier.name, error: String(err) }))
  }, [save])

  const remove = useCallback((name: string) => {
    void window.ion.removeModelTier(name).then((result) => {
      if (!result.ok) throw new Error(result.error || 'Could not remove model tier')
      setTiers((current) => current.filter((tier) => tier.name !== name))
      rInfo('model-tiers', 'model tier removed', { tier: name })
    }).catch((err) => rWarn('model-tiers', 'model tier removal failed', { tier: name, error: String(err) }))
  }, [])

  const addTier = useCallback(() => {
    const name = newTier.name.trim().toLowerCase()
    if (!name || !newTier.model || STANDARD_TIERS.includes(name as typeof STANDARD_TIERS[number]) || tiers.some((tier) => tier.name === name)) return
    void save({ name, model: newTier.model, fallbacks: newTier.fallbacks.slice(0, 1) })
      .then(() => setNewTier(EMPTY_TIER))
      .catch((err) => rWarn('model-tiers', 'new model tier save failed', { tier: name, error: String(err) }))
  }, [newTier, save, tiers])

  const cardStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
    gap: 8,
    alignItems: 'end',
    padding: 10,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    background: colors.surfacePrimary,
    minWidth: 0,
  }
  const fieldStyle: React.CSSProperties = { display: 'grid', gap: 4, minWidth: 0 }
  const labelStyle: React.CSSProperties = { color: colors.textTertiary, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }
  const selectStyle: React.CSSProperties = { width: '100%', minWidth: 0, padding: '4px 6px', background: colors.surfacePrimary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 5, fontSize: 12 }
  const iconStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: colors.textSecondary, cursor: 'pointer', padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }
  const optionValues = (tier: ModelTier) => modelChoices(models, tier.model, tier.fallbacks[0])

  return (
    <SettingSection label="Model Tiers" description="Choose each tier’s primary model and one managed fallback. Existing additional fallbacks remain active in the engine.">
      {loading ? <span style={{ color: colors.textTertiary, fontSize: 12 }}>Loading model tiers…</span> : (
        <div data-testid="model-tier-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 8, minWidth: 0 }}>
          {displayTiers.map((tier) => {
            const builtIn = STANDARD_TIERS.includes(tier.name as typeof STANDARD_TIERS[number])
            const choices = optionValues(tier)
            return (
              <div key={tier.name} style={cardStyle}>
                <div style={{ ...fieldStyle, alignSelf: 'center' }}>
                  <span style={labelStyle}>Tier</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                    <strong style={{ color: colors.textPrimary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tier.name}</strong>
                    {builtIn && <Tooltip text="Built-in tier. It stays available and needs an explicit primary model."><span style={{ display: 'inline-flex', color: colors.accent, flexShrink: 0 }}><ShieldCheck size={13} /></span></Tooltip>}
                  </div>
                </div>
                <label style={fieldStyle}><span style={labelStyle}>Primary model</span><ModelSelect ariaLabel={`${tier.name} primary model`} value={tier.model} emptyLabel={tier.name === WORKBENCH_SYNC_TIER ? 'Default (uses standard tier)' : builtIn ? 'Configure a primary model' : 'Select primary model'} choices={choices} onChange={(model) => updatePrimary(tier, model)} style={selectStyle} /></label>
                <label style={fieldStyle}><span style={labelStyle}>Fallback model</span><ModelSelect ariaLabel={`${tier.name} fallback model`} value={tier.fallbacks[0] ?? ''} emptyLabel="None" choices={choices} onChange={(model) => updateFallback(tier, model)} style={selectStyle} /></label>
                {!builtIn && <button aria-label={`Remove ${tier.name} tier`} onClick={() => remove(tier.name)} style={iconStyle}><Trash size={16} /></button>}
              </div>
            )
          })}
          <div style={cardStyle}>
            <label style={fieldStyle}><span style={labelStyle}>Tier</span><input aria-label="Tier name" placeholder="New tier" value={newTier.name} onChange={(event) => setNewTier({ ...newTier, name: event.target.value })} style={selectStyle} /></label>
            <label style={fieldStyle}><span style={labelStyle}>Primary model</span><ModelSelect ariaLabel="New tier primary model" value={newTier.model} emptyLabel="Select primary model" choices={modelChoices(models, newTier.model, newTier.fallbacks[0])} onChange={(model) => setNewTier({ ...newTier, model })} style={selectStyle} /></label>
            <label style={fieldStyle}><span style={labelStyle}>Fallback model</span><ModelSelect ariaLabel="New tier fallback model" value={newTier.fallbacks[0] ?? ''} emptyLabel="None" choices={modelChoices(models, newTier.model, newTier.fallbacks[0])} onChange={(fallback) => setNewTier({ ...newTier, fallbacks: fallback ? [fallback] : [] })} style={selectStyle} /></label>
            <button aria-label="Add custom tier" onClick={addTier} disabled={!newTier.name.trim() || !newTier.model} style={iconStyle}><Plus size={18} /></button>
          </div>
        </div>
      )}
    </SettingSection>
  )
}

function ModelSelect({ ariaLabel, value, emptyLabel, choices, onChange, style }: { ariaLabel: string; value: string; emptyLabel: string; choices: Map<string, Array<{ value: string; unavailable: boolean }>>; onChange: (value: string) => void; style: React.CSSProperties }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} style={style}>
    <option value="">{emptyLabel}</option>
    {Array.from(choices.entries()).map(([providerId, entries]) => (
      <optgroup key={providerId} label={providerId}>
        {entries.map(({ value, unavailable }, index) => <option key={`${value}-${index}`} value={value}>{unavailable ? `${value} (unavailable)` : value}</option>)}
      </optgroup>
    ))}
  </select>
}

function orderedTiers(tiers: ModelTier[]): ModelTier[] {
  const byName = new Map(tiers.map((tier) => [tier.name, tier]))
  return [
    ...STANDARD_TIERS.map((name) => byName.get(name) ?? { name, model: '', fallbacks: [] }),
    ...tiers.filter((tier) => !STANDARD_TIERS.includes(tier.name as typeof STANDARD_TIERS[number])),
  ]
}

function modelChoices(available: Array<{ id: string; providerId: string }>, ...configured: Array<string | undefined>): Map<string, Array<{ value: string; unavailable: boolean }>> {
  const groups = new Map<string, Array<{ value: string; unavailable: boolean }>>()
  for (const [providerId, entries] of groupModelChoices(available)) {
    groups.set(providerId, entries.map(({ value }) => ({ value, unavailable: false })))
  }
  const known = new Set(Array.from(groups.values()).flat().map((entry) => entry.value))
  for (const value of configured) {
    if (!value || known.has(value)) continue
    const providerId = value.includes('/') ? value.slice(0, value.indexOf('/')) : 'Unknown'
    const entries = groups.get(providerId) ?? []
    entries.push({ value, unavailable: true })
    groups.set(providerId, entries)
  }
  return groups
}
