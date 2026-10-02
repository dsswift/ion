/**
 * DefaultModelsSection — your default models on the server Settings is
 * editing: the conversation and engine defaults, and the optional split
 * between a planning model and an implementation model. Only a model that
 * server offers, and its model policy permits, can be a default there.
 */
import React, { useEffect, useMemo } from 'react'
import type { ModelEntry } from '@ion/shared/types-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { useAllowedModels } from '../../../../stores/use-allowed-models'
import { rWarn } from '../../../../rendererLogger'
import { useSettingsPreferences, useSettingsTargetEnvironmentId } from '../../settings-target'
import { groupServerModels, serverOffersModel } from '../../server-models'
import { useEnvironmentEnterprisePolicy } from '../../use-environment-enterprise-policy'
import { FormGroup, FormRow, Segmented, Select, Stack, ToggleRow } from '../../kit'

const PICKER_WIDTH = 260

export function DefaultModelsSection(): React.JSX.Element {
  const preferredModel = useSettingsPreferences((s) => s.preferredModel)
  const setPreferredModel = useSettingsPreferences((s) => s.setPreferredModel)
  const engineDefaultModel = useSettingsPreferences((s) => s.engineDefaultModel)
  const setEngineDefaultModel = useSettingsPreferences((s) => s.setEngineDefaultModel)
  const planModelSplitEnabled = useSettingsPreferences((s) => s.planModelSplitEnabled)
  const setPlanModelSplitEnabled = useSettingsPreferences((s) => s.setPlanModelSplitEnabled)
  const planModeModel = useSettingsPreferences((s) => s.planModeModel)
  const setPlanModeModel = useSettingsPreferences((s) => s.setPlanModeModel)
  const implementModeModel = useSettingsPreferences((s) => s.implementModeModel)
  const setImplementModeModel = useSettingsPreferences((s) => s.setImplementModeModel)
  const environmentId = useSettingsTargetEnvironmentId()
  const fetchModelsFor = useModelStore((s) => s.fetchModelsFor)
  const slice = useModelStore((s) => environmentModels(s, environmentId))
  const policy = useEnvironmentEnterprisePolicy(environmentId)

  useEffect(() => {
    if (environmentModels(useModelStore.getState(), environmentId).models.length > 0) return
    void fetchModelsFor(environmentId).catch((err: unknown) => rWarn('settings', 'fetch models failed', { environment_id: environmentId, error: String(err) }))
  }, [environmentId, fetchModelsFor])

  const grouped = useMemo(() => groupServerModels({ models: slice.models, providers: slice.providers }, policy), [slice.models, slice.providers, policy])

  return (
    <Stack gap={20}>
      <FormGroup title="Defaults" anchor="default-model">
        <FormRow label="Default conversation model" settingKey="preferredModel" description="The model new tabs use for conversations. Can be overridden per-tab from the status bar.">
          <ModelPicker value={preferredModel || ''} onChange={setPreferredModel} grouped={grouped} environmentId={environmentId} label="Default conversation model" />
        </FormRow>
        <FormRow label="Default engine model" settingKey="engineDefaultModel" description="The model used for engine tasks. 'Default' uses the conversation model.">
          <ModelPicker value={engineDefaultModel || ''} onChange={setEngineDefaultModel} grouped={grouped} environmentId={environmentId} emptyLabel="Default" label="Default engine model" />
        </FormRow>
      </FormGroup>
      <FormGroup title="Plan and implement" anchor="plan-split">
        <ToggleRow
          label="Model splitting" settingKey="planModelSplitEnabled"
          description="Automatically switch models at the plan/implement boundary. Use a powerful model for planning and a faster one for implementation."
          checked={planModelSplitEnabled}
          onChange={setPlanModelSplitEnabled}
        />
        {planModelSplitEnabled && (
          <FormRow label="Planning model" settingKey="planModeModel" description="Model to use when a tab is in plan mode. Overrides the default conversation model.">
            <ModelPicker value={planModeModel || ''} onChange={setPlanModeModel} grouped={grouped} environmentId={environmentId} emptyLabel="Default (use conversation model)" label="Planning model" />
          </FormRow>
        )}
        {planModelSplitEnabled && (
          <FormRow label="Implementation model" settingKey="implementModeModel" description="Model to use when implementing a plan. Automatically applied when you click Implement.">
            <ModelPicker value={implementModeModel || ''} onChange={setImplementModeModel} grouped={grouped} environmentId={environmentId} emptyLabel="Default (use conversation model)" label="Implementation model" />
          </FormRow>
        )}
      </FormGroup>
    </Stack>
  )
}

/**
 * One model default. With the server's models known, a select grouped by
 * provider; a saved value that server does not offer shows as what it is
 * instead of silently displaying the first model. Before they are known, the
 * policy's allowed models as a segmented control.
 */
function ModelPicker({ value, onChange, grouped, environmentId, emptyLabel, label }: {
  value: string
  onChange(modelId: string): void
  grouped: ReadonlyMap<string, ModelEntry[]>
  environmentId: string
  /** Label for "no choice". Omitted when the setting has no such state; an unset value then reads "Not set". */
  emptyLabel?: string
  label: string
}): React.JSX.Element {
  const availableModels = useAllowedModels(environmentId)
  if (grouped.size === 0) {
    const options = [
      ...(emptyLabel !== undefined ? [{ value: '', label: 'Default' }] : []),
      ...availableModels.map((m) => ({ value: m.id, label: m.label })),
    ]
    return <Segmented<string> label={label} value={value} options={options} onChange={onChange} />
  }
  const foreign = value !== '' && !serverOffersModel(grouped, value)
  return (
    <Select aria-label={label} width={PICKER_WIDTH} value={value} onChange={(e) => onChange(e.target.value)}>
      {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : value === '' && <option value="">Not set</option>}
      {foreign && <option value={value}>{value} (not on this server)</option>}
      {Array.from(grouped.entries()).map(([provider, models]) => (
        <optgroup key={provider} label={provider}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </optgroup>
      ))}
    </Select>
  )
}
