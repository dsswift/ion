import React, { useEffect, useMemo } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import { EngineCategory } from './EngineCategory'
import { ProvidersCategory } from './ProvidersCategory'
import { AVAILABLE_MODELS, getModelDisplayLabel } from '../../stores/model-labels'
import { useModelStore } from '../../stores/model-store'
import { getProviderDisplayName } from '../../../shared/types-models'

export function AIModelsCategory() {
  const colors = useColors()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const setPreferredModel = usePreferencesStore((s) => s.setPreferredModel)
  const engineDefaultModel = usePreferencesStore((s) => s.engineDefaultModel)
  const setEngineDefaultModel = usePreferencesStore((s) => s.setEngineDefaultModel)

  const fetchModels = useModelStore((s) => s.fetchModels)
  const dynamicModels = useModelStore((s) => s.models)
  const providers = useModelStore((s) => s.providers)
  const hasModels = dynamicModels.length > 0

  useEffect(() => {
    if (!hasModels) fetchModels()
  }, [hasModels, fetchModels])

  const authedProviderIds = useMemo(() => {
    return new Set(providers.filter((p) => p.hasAuth).map((p) => p.id))
  }, [providers])

  const grouped = useMemo(() => {
    if (!hasModels) return null
    const map = new Map<string, typeof dynamicModels>()
    for (const m of dynamicModels) {
      if (!authedProviderIds.has(m.providerId)) continue
      const list = map.get(m.providerId) || []
      list.push(m)
      map.set(m.providerId, list)
    }
    return map
  }, [dynamicModels, hasModels, authedProviderIds])

  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '7px 10px',
    background: colors.surfacePrimary,
    color: colors.textPrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
    outline: 'none',
  }

  const segmentStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '7px 0',
    background: active ? colors.accent : 'transparent',
    color: active ? '#fff' : colors.textSecondary,
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    transition: 'background 0.15s, color 0.15s',
  })

  const segmentContainer: React.CSSProperties = {
    display: 'flex',
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    overflow: 'hidden',
  }

  return (
    <>
      <SettingHeading first>Models</SettingHeading>

      <SettingSection
        label="Default Conversation Model"
        description="The model new tabs use for conversations. Can be overridden per-tab from the status bar."
      >
        {grouped && grouped.size > 0 ? (
          <select
            value={preferredModel || ''}
            onChange={(e) => setPreferredModel(e.target.value)}
            style={selectStyle}
          >
            {Array.from(grouped.entries()).map(([providerId, models]) => (
              <optgroup key={providerId} label={getProviderDisplayName(providerId)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{getModelDisplayLabel(m.id)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <div style={segmentContainer}>
            {AVAILABLE_MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => setPreferredModel(m.id)}
                style={segmentStyle(preferredModel === m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </SettingSection>

      <SettingSection
        label="Default Engine Model"
        description="The model used for engine tasks. 'Default' uses the conversation model."
      >
        {grouped && grouped.size > 0 ? (
          <select
            value={engineDefaultModel || ''}
            onChange={(e) => setEngineDefaultModel(e.target.value)}
            style={selectStyle}
          >
            <option value="">Default</option>
            {Array.from(grouped.entries()).map(([providerId, models]) => (
              <optgroup key={providerId} label={getProviderDisplayName(providerId)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{getModelDisplayLabel(m.id)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <div style={segmentContainer}>
            <button
              onClick={() => setEngineDefaultModel('')}
              style={segmentStyle(engineDefaultModel === '')}
            >
              Default
            </button>
            {AVAILABLE_MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => setEngineDefaultModel(m.id)}
                style={segmentStyle(engineDefaultModel === m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </SettingSection>

      <ProvidersCategory />

      <EngineCategory />
    </>
  )
}
