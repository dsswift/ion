import React, { useState } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import {
  AI_ASSIST_WORKFLOWS,
  validateAiAssistTemplate,
  type AiAssistWorkflowId,
} from '../../../shared/ai-assist-workflows'
import { usePreferencesStore } from '../../preferences'
import { rInfo, rWarn } from '../../rendererLogger'
import { useColors } from '../../theme'
import { SettingHeading } from './SettingHeading'
import { SettingSection } from './SettingSection'

export function AIAssistWorkflowsCategory() {
  return (
    <>
      <SettingHeading first>AI-Assisted Workflows</SettingHeading>
      {AI_ASSIST_WORKFLOWS.map((workflow) => <WorkflowEditor key={workflow.id} workflowId={workflow.id} />)}
    </>
  )
}

function WorkflowEditor({ workflowId }: { workflowId: AiAssistWorkflowId }) {
  const colors = useColors()
  const workflow = AI_ASSIST_WORKFLOWS.find((entry) => entry.id === workflowId)!
  const persisted = usePreferencesStore((state) => state.aiAssistPromptOverrides[workflowId])
  const setOverride = usePreferencesStore((state) => state.setAiAssistPromptOverride)
  const [draft, setDraft] = useState(persisted ?? workflow.defaultTemplate)
  const [dirty, setDirty] = useState(false)
  const validationError = validateAiAssistTemplate(workflowId, draft)

  const save = () => {
    if (validationError) {
      rWarn('ai-assist.settings', 'workflow prompt save blocked by validation', {
        workflow: workflowId, error: validationError,
      })
      return
    }
    const override = draft === workflow.defaultTemplate ? null : draft
    setOverride(workflowId, override)
    setDirty(false)
    rInfo('ai-assist.settings', 'workflow prompt saved', {
      workflow: workflowId, overridden: override !== null,
    })
  }

  const reset = () => {
    setDraft(workflow.defaultTemplate)
    setOverride(workflowId, null)
    setDirty(false)
    rInfo('ai-assist.settings', 'workflow prompt reset to default', { workflow: workflowId })
  }

  const buttonStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`,
    background: colors.surfacePrimary, color: colors.textSecondary, cursor: 'pointer', fontSize: 12,
  }

  return (
    <SettingSection label={workflow.label} description={workflow.description}>
      <textarea
        aria-label={`${workflow.label} prompt`}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setDirty(true) }}
        spellCheck={false}
        style={{
          width: '100%', minHeight: 170, resize: 'vertical', boxSizing: 'border-box',
          padding: 10, borderRadius: 8, border: `1px solid ${validationError ? colors.statusError : colors.containerBorder}`,
          background: colors.surfacePrimary, color: colors.textPrimary, fontSize: 12,
          fontFamily: 'Menlo, Monaco, monospace', lineHeight: 1.45, outline: 'none',
        }}
      />
      <div style={{ marginTop: 6, color: validationError ? colors.statusError : colors.textTertiary, fontSize: 11 }}>
        {validationError ?? `Placeholders: ${workflow.placeholders.map((name) => `{{${name}}}`).join(', ') || 'none'}`}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
        <button aria-label={`Reset ${workflow.label} prompt`} onClick={reset} style={{ ...buttonStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
          <ArrowCounterClockwise size={13} /> Reset to default
        </button>
        <button
          aria-label={`Save ${workflow.label} prompt`}
          onClick={save}
          disabled={!dirty || !!validationError || !draft.trim()}
          style={{ ...buttonStyle, background: colors.accent, color: colors.textOnAccent, opacity: !dirty || validationError || !draft.trim() ? 0.5 : 1 }}
        >
          Save
        </button>
      </div>
    </SettingSection>
  )
}
