import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import { SettingToggle } from './SettingToggle'
import { EngineCategory } from './EngineCategory'
import { ProvidersCategory } from './ProvidersCategory'
import { BashAllowlistEditor } from './BashAllowlistEditor'
import { AVAILABLE_MODELS, getModelDisplayLabel } from '../../stores/model-labels'
import { useModelStore } from '../../stores/model-store'
import { getProviderDisplayName } from '../../../shared/types-models'

export function AIModelsCategory() {
  const colors = useColors()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const setPreferredModel = usePreferencesStore((s) => s.setPreferredModel)
  const engineDefaultModel = usePreferencesStore((s) => s.engineDefaultModel)
  const setEngineDefaultModel = usePreferencesStore((s) => s.setEngineDefaultModel)
  const planModelSplitEnabled = usePreferencesStore((s) => s.planModelSplitEnabled)
  const setPlanModelSplitEnabled = usePreferencesStore((s) => s.setPlanModelSplitEnabled)
  const planModeModel = usePreferencesStore((s) => s.planModeModel)
  const setPlanModeModel = usePreferencesStore((s) => s.setPlanModeModel)
  const implementModeModel = usePreferencesStore((s) => s.implementModeModel)
  const setImplementModeModel = usePreferencesStore((s) => s.setImplementModeModel)
  const showImplementClearContext = usePreferencesStore((s) => s.showImplementClearContext)
  const setShowImplementClearContext = usePreferencesStore((s) => s.setShowImplementClearContext)
  const thinkingEnabled = usePreferencesStore((s) => s.thinkingEnabled)
  const setThinkingEnabled = usePreferencesStore((s) => s.setThinkingEnabled)
  // The plan-mode Bash allowlist is ENGINE POLICY, stored in engine.json
  // (limits.planModeAllowedBashCommands) — not a desktop preference. We read
  // it from / write it to engine.json via IPC rather than the preferences
  // store, so the editor shows the operator's real engine.json contents and a
  // save lands where the engine reads it. The engine re-reads fresh at each
  // dispatch, so no restart is needed.
  const [planModeAllowedBashCommands, setPlanModeAllowedBashCommandsState] = useState<string[]>([])
  useEffect(() => {
    window.ion.getPlanBashAllowlist().then(setPlanModeAllowedBashCommandsState).catch(() => {
      // Read failure degrades to an empty editor; the next successful save
      // still writes engine.json. Nothing user-facing to surface here.
    })
  }, [])
  const setPlanModeAllowedBashCommands = useCallback((cmds: string[]) => {
    setPlanModeAllowedBashCommandsState(cmds)
    window.ion.setPlanBashAllowlist(cmds).catch(() => {
      // Write failure leaves the on-disk value unchanged; the editor state is
      // optimistic. A subsequent successful save reconciles.
    })
  }, [])

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

      <SettingHeading>Extended Thinking</SettingHeading>

      <SettingToggle
        label="Enable extended thinking"
        description="Let models reason before answering. When on, each conversation gets an Off/Low/Medium/High thinking control in its status bar (per conversation, applied on the next prompt). Thinking improves hard multi-step tasks but bills reasoning as output tokens, so it adds cost. Off by default. Only models that support reasoning show the control."
        checked={thinkingEnabled}
        onChange={setThinkingEnabled}
      />

      <SettingHeading>Plan & Implement Models</SettingHeading>

      <SettingToggle
        label="Model Splitting"
        description="Automatically switch models at the plan/implement boundary. Use a powerful model for planning and a faster one for implementation."
        checked={planModelSplitEnabled}
        onChange={setPlanModelSplitEnabled}
      />

      <SettingToggle
        label={'Show "Implement, clear context" button'}
        description="Reveal a second action on the plan-approval card that starts a fresh conversation for the implementation phase. The regular Implement button always preserves the conversation so the model keeps what it learned during planning. Use /clear to clear context manually at any time."
        checked={showImplementClearContext}
        onChange={setShowImplementClearContext}
      />

      {planModelSplitEnabled && (
        <>
          <SettingSection
            label="Planning Model"
            description="Model to use when a tab is in plan mode. Overrides the default conversation model."
          >
            {grouped && grouped.size > 0 ? (
              <select
                value={planModeModel || ''}
                onChange={(e) => setPlanModeModel(e.target.value)}
                style={selectStyle}
              >
                <option value="">Default (use conversation model)</option>
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
                  onClick={() => setPlanModeModel('')}
                  style={segmentStyle(planModeModel === '')}
                >
                  Default
                </button>
                {AVAILABLE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setPlanModeModel(m.id)}
                    style={segmentStyle(planModeModel === m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </SettingSection>

          <SettingSection
            label="Implementation Model"
            description="Model to use when implementing a plan. Automatically applied when you click Implement."
          >
            {grouped && grouped.size > 0 ? (
              <select
                value={implementModeModel || ''}
                onChange={(e) => setImplementModeModel(e.target.value)}
                style={selectStyle}
              >
                <option value="">Default (use conversation model)</option>
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
                  onClick={() => setImplementModeModel('')}
                  style={segmentStyle(implementModeModel === '')}
                >
                  Default
                </button>
                {AVAILABLE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setImplementModeModel(m.id)}
                    style={segmentStyle(implementModeModel === m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </SettingSection>
        </>
      )}

      <SettingHeading>Plan Mode</SettingHeading>

      <SettingSection
        label="Allowed Bash commands in plan mode"
        description="Command prefixes the agent may invoke via Bash while in plan mode. Token-based prefix matching: &quot;gh&quot; matches &quot;gh pr view&quot; but not &quot;ghost&quot;. Empty list = Bash blocked entirely. iOS edits the same list via the projected setting in Desktop Settings → AI & Models."
      >
        <BashAllowlistEditor
          value={planModeAllowedBashCommands}
          onChange={setPlanModeAllowedBashCommands}
        />
      </SettingSection>

      <ProvidersCategory />

      <EngineCategory />
    </>
  )
}
