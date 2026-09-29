/**
 * AIWorkflowsSection — the prompt each fixed AI-assisted workflow (rebase,
 * merge resolution, bench verification, …) sends. One row per workflow says
 * whether it runs the built-in prompt or yours; the prompt is edited in a
 * side panel and must pass the workflow's placeholder check to save.
 */
import React, { useState } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { AI_ASSIST_WORKFLOWS, validateAiAssistTemplate, type AiAssistWorkflowId } from '@ion/shared/ai-assist-workflows'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useSettingsPreferences } from '../../settings-target'
import { Button, CellText, Chip, DataList, ErrorText, Muted, SidePanel, Stack, TextArea } from '../../kit'

type Workflow = typeof AI_ASSIST_WORKFLOWS[number]

export function AIWorkflowsSection(): React.JSX.Element {
  const overrides = useSettingsPreferences((state) => state.aiAssistPromptOverrides)
  const [openId, setOpenId] = useState<AiAssistWorkflowId | null>(null)
  const open = openId ? AI_ASSIST_WORKFLOWS.find((w) => w.id === openId) : undefined
  return (
    <>
      <DataList<Workflow>
        label="AI workflow prompts"
        title="AI workflow prompts"
        description="The prompt each AI-assisted workflow sends."
        anchor="ai-workflows"
        items={AI_ASSIST_WORKFLOWS}
        getKey={(w) => w.id}
        onRowClick={(w) => setOpenId(w.id)}
        columns={[
          { id: 'name', render: (w) => <CellText>{w.label}</CellText> },
          { id: 'description', width: 'minmax(0, 1.4fr)', render: (w) => <CellText muted>{w.description}</CellText> },
          { id: 'state', width: '90px', align: 'end', render: (w) => (overrides[w.id] ? <Chip tone="accent">Customized</Chip> : <Chip>Default</Chip>) },
        ]}
      />
      {open && <WorkflowPanel key={open.id} workflow={open} onClose={() => setOpenId(null)} />}
    </>
  )
}

function WorkflowPanel({ workflow, onClose }: { workflow: Workflow; onClose(): void }): React.JSX.Element {
  const persisted = useSettingsPreferences((state) => state.aiAssistPromptOverrides[workflow.id])
  const setOverride = useSettingsPreferences((state) => state.setAiAssistPromptOverride)
  const [draft, setDraft] = useState(persisted ?? workflow.defaultTemplate)
  const [dirty, setDirty] = useState(false)
  const validationError = validateAiAssistTemplate(workflow.id, draft)

  const save = (): void => {
    if (validationError) {
      rWarn('ai-assist.settings', 'workflow prompt save blocked by validation', { workflow: workflow.id, error: validationError })
      return
    }
    const override = draft === workflow.defaultTemplate ? null : draft
    setOverride(workflow.id, override)
    setDirty(false)
    rInfo('ai-assist.settings', 'workflow prompt saved', { workflow: workflow.id, overridden: override !== null })
  }

  const reset = (): void => {
    setDraft(workflow.defaultTemplate)
    setOverride(workflow.id, null)
    setDirty(false)
    rInfo('ai-assist.settings', 'workflow prompt reset to default', { workflow: workflow.id })
  }

  return (
    <SidePanel
      open
      title={workflow.label}
      subtitle={workflow.description}
      onClose={onClose}
      footer={<>
        <Button icon={ArrowCounterClockwise} aria-label={`Reset ${workflow.label} prompt`} onClick={reset}>Reset to default</Button>
        <Button variant="primary" aria-label={`Save ${workflow.label} prompt`} disabled={!dirty || !!validationError || !draft.trim()} onClick={save}>Save</Button>
      </>}
    >
      <Stack gap={8}>
        <TextArea
          mono
          rows={22}
          aria-label={`${workflow.label} prompt`}
          value={draft}
          spellCheck={false}
          onChange={(event) => { setDraft(event.target.value); setDirty(true) }}
        />
        {validationError
          ? <ErrorText>{validationError}</ErrorText>
          : <Muted>{`Placeholders: ${workflow.placeholders.map((name) => `{{${name}}}`).join(', ') || 'none'}`}</Muted>}
      </Stack>
    </SidePanel>
  )
}
