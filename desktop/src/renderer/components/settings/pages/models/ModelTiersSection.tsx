/**
 * ModelTiersSection — how one server's engine routes models: its default
 * provider, and its model tiers, each with a primary model and the one
 * fallback this client manages. Every read and write goes to that server,
 * and the engine's tier broadcast keeps the table live.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, ShieldCheck, Trash } from '@phosphor-icons/react'
import { WORKBENCH_SYNC_TIER, type ModelTier } from '@ion/shared/types-model-tiers'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useColors } from '../../../../theme'
import { Tooltip } from '../../../git/Tooltip'
import { useSettingsEnvironment } from '../../settings-servers'
import { Button, CellText, DataList, ErrorText, Field, FormGroup, Select, SidePanel, Stack, TextInput } from '../../kit'
import { DefaultProviderRow } from './DefaultProviderRow'
import { isBuiltInTier, modelChoices, orderedTiers, type ModelChoice } from './model-tier-choices'

const EMPTY_TIER: ModelTier = { name: '', model: '', fallbacks: [] }
const SELECT_WIDTH = 210

export function ModelTiersSection(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const environmentId = env.id
  const colors = useColors()
  const models = useModelStore((state) => environmentModels(state, environmentId).models)
  const [tiers, setTiers] = useState<ModelTier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const listingRef = useRef(false)
  const displayTiers = useMemo(() => orderedTiers(tiers), [tiers])

  const load = useCallback(async () => {
    if (listingRef.current) return
    listingRef.current = true
    try {
      const next = await withTargetEnvironment(environmentId, () => host.shell.listModelTiers())
      setTiers(next)
      rInfo('model-tiers', 'model tier snapshot loaded', { environment_id: environmentId, count: next.length })
    } catch (err) {
      rWarn('model-tiers', 'model tier snapshot load failed', { error: String(err) })
    } finally {
      listingRef.current = false
      setLoading(false)
    }
  }, [environmentId])

  useEffect(() => {
    void load()
    return host.shell.onModelTiersUpdated((_payload, fromEnvironment) => {
      if (fromEnvironment !== undefined && fromEnvironment !== environmentId) return
      // Our own list request emits the snapshot it returns; reloading on it would recurse.
      if (!listingRef.current) void load()
    })
  }, [load, environmentId])

  const save = useCallback(async (tier: ModelTier) => {
    const result = await withTargetEnvironment(environmentId, () => host.shell.setModelTier(tier))
    if (!result.ok) throw new Error(result.error || 'Could not save model tier')
    setTiers((current) => [...current.filter(({ name }) => name !== tier.name), tier].sort((a, b) => a.name.localeCompare(b.name)))
    rInfo('model-tiers', 'model tier saved', { environment_id: environmentId, tier: tier.name, model: tier.model, fallbackCount: tier.fallbacks.length })
  }, [environmentId])

  const fail = (message: string, tier: string) => (err: unknown): void => {
    rWarn('model-tiers', message, { tier, error: String(err) })
    setError(err instanceof Error ? err.message : String(err))
  }

  const updatePrimary = (tier: ModelTier, model: string): void => {
    if (!model) return
    setError(null)
    void save({ ...tier, model }).catch(fail('primary model save failed', tier.name))
  }

  const updateFallback = (tier: ModelTier, fallback: string): void => {
    // This client owns only index zero. The engine keeps a full chain; the
    // rest is preserved verbatim so other consumers keep their policy.
    const fallbacks = fallback ? [fallback, ...tier.fallbacks.slice(1)] : tier.fallbacks.slice(1)
    setError(null)
    void save({ ...tier, fallbacks }).catch(fail('fallback model save failed', tier.name))
  }

  const remove = (name: string): void => {
    setError(null)
    void withTargetEnvironment(environmentId, () => host.shell.removeModelTier(name)).then((result) => {
      if (!result.ok) throw new Error(result.error || 'Could not remove model tier')
      setTiers((current) => current.filter((tier) => tier.name !== name))
      rInfo('model-tiers', 'model tier removed', { tier: name })
    }).catch(fail('model tier removal failed', name))
  }

  return (
    <Stack gap={20}>
      <FormGroup title="Routing">
        <DefaultProviderRow environmentId={environmentId} />
      </FormGroup>
      <div>
        <DataList<ModelTier>
          label="Model tiers"
          title="Model tiers"
          description="Each tier’s primary model and one managed fallback. Additional fallbacks set elsewhere stay active in the engine."
          anchor="tiers"
          items={loading ? [] : displayTiers}
          loading={loading}
          getKey={(tier) => tier.name}
          noun={['tier', 'tiers']}
          showHeader
          columns={[
            {
              id: 'tier', header: 'Tier',
              render: (tier) => <>
                <CellText>{tier.name}</CellText>
                {isBuiltInTier(tier.name) && (
                  <Tooltip text="Built-in tier. It stays available and needs an explicit primary model.">
                    <span aria-label="Built-in tier" style={{ display: 'inline-flex', color: colors.accent }}><ShieldCheck size={13} /></span>
                  </Tooltip>
                )}
              </>,
            },
            {
              id: 'primary', header: 'Primary', width: `${SELECT_WIDTH}px`,
              render: (tier) => {
                const builtIn = isBuiltInTier(tier.name)
                return <ModelSelect label={`${tier.name} primary model`} value={tier.model} emptyLabel={tier.name === WORKBENCH_SYNC_TIER ? 'Default (uses standard tier)' : builtIn ? 'Configure a primary model' : 'Select primary model'} choices={modelChoices(models, tier.model, tier.fallbacks[0])} onChange={(model) => updatePrimary(tier, model)} />
              },
            },
            {
              id: 'fallback', header: 'Fallback', width: `${SELECT_WIDTH}px`,
              render: (tier) => <ModelSelect label={`${tier.name} fallback model`} value={tier.fallbacks[0] ?? ''} emptyLabel="None" choices={modelChoices(models, tier.model, tier.fallbacks[0])} onChange={(model) => updateFallback(tier, model)} />,
            },
          ]}
          rowMenu={(tier) => [!isBuiltInTier(tier.name) && { label: `Remove ${tier.name} tier`, icon: Trash, danger: true, onSelect: () => remove(tier.name) }]}
          actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add tier</Button>}
        />
        <ErrorText>{error}</ErrorText>
      </div>
      <AddTierPanel open={adding} onClose={() => setAdding(false)} models={models} existing={tiers} save={save} />
    </Stack>
  )
}

function ModelSelect({ label, value, emptyLabel, choices, onChange }: { label: string; value: string; emptyLabel: string; choices: Map<string, ModelChoice[]>; onChange(value: string): void }): React.JSX.Element {
  return (
    <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {Array.from(choices.entries()).map(([providerId, entries]) => (
        <optgroup key={providerId} label={providerId}>
          {entries.map(({ value: v, unavailable }, index) => <option key={`${v}-${index}`} value={v}>{unavailable ? `${v} (unavailable)` : v}</option>)}
        </optgroup>
      ))}
    </Select>
  )
}

function AddTierPanel({ open, onClose, models, existing, save }: {
  open: boolean
  onClose(): void
  models: Array<{ id: string; providerId: string }>
  existing: ModelTier[]
  save(tier: ModelTier): Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(EMPTY_TIER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = draft.name.trim().toLowerCase()
  const taken = name !== '' && (isBuiltInTier(name) || existing.some((tier) => tier.name === name))
  const choices = modelChoices(models, draft.model, draft.fallbacks[0])
  const close = (): void => { setDraft(EMPTY_TIER); setError(null); onClose() }

  const add = (): void => {
    if (!name || !draft.model || taken) return
    setBusy(true); setError(null)
    void save({ name, model: draft.model, fallbacks: draft.fallbacks.slice(0, 1) })
      .then(close)
      .catch((err: unknown) => {
        rWarn('model-tiers', 'new model tier save failed', { tier: name, error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(false))
  }

  return (
    <SidePanel
      open={open}
      title="Add a model tier"
      subtitle="A custom tier routes to its primary model, then its fallback."
      onClose={close}
      footer={<>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" aria-label="Add custom tier" disabled={busy || !name || !draft.model || taken} onClick={add}>{busy ? 'Adding…' : 'Add tier'}</Button>
      </>}
    >
      <Stack>
        <Field label="Name" hint={taken ? 'A tier with that name already exists.' : 'Lowercase; built-in tier names are reserved.'}>
          <TextInput aria-label="Tier name" placeholder="review" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Primary model">
          <ModelSelect label="New tier primary model" value={draft.model} emptyLabel="Select primary model" choices={choices} onChange={(model) => setDraft({ ...draft, model })} />
        </Field>
        <Field label="Fallback model">
          <ModelSelect label="New tier fallback model" value={draft.fallbacks[0] ?? ''} emptyLabel="None" choices={choices} onChange={(fallback) => setDraft({ ...draft, fallbacks: fallback ? [fallback] : [] })} />
        </Field>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
