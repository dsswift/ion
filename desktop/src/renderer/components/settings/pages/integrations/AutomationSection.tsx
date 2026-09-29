/**
 * AutomationSection — desktop automations on the picked server: a scope
 * (an optional project directory), the source-aware list of automations,
 * and the recent activity with each run's stored evaluation path. The server
 * owns evaluation and persistence; this section reads the listing and asks
 * for one change at a time. Editing and creating happen in side panels.
 */
import React, { useEffect, useState } from 'react'
import { Copy, Lightning, PencilSimple, Plus, Sparkle, Trash } from '@phosphor-icons/react'
import type { AutomationDefinition, AutomationHistoryEntry, AutomationListing, AutomationSourceEntry } from '@ion/shared/types-automation'
import { deriveEnterpriseAutomationPolicy } from '@ion/shared/types-automation'
import type { EnterprisePolicy } from '@ion/shared/types-engine'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useSettingsShell } from '../../settings-shell'
import { useSettingsEnvironment } from '../../settings-servers'
import { AUTOMATION_TEMPLATES } from '../../automation-editor-helpers'
import { Button, CellText, Chip, DataList, EmptyState, ErrorText, FormGroup, FormRow, Muted, Notice, SidePanel, Stack, Switch, TextInput } from '../../kit'
import { AutomationEditorPanel } from './AutomationEditorPanel'
import { AutomationActivityList } from './AutomationActivityList'
import { actionSummary, blankAutomation, sourceLabel, triggerLabel } from './automation-describe'

/**
 * Whether `editing` is one of the listing's own entries rather than a draft.
 * A template assigns a real id at once, so a blank-id check cannot tell new
 * from saved; membership in the listing can.
 */
function isSavedEntry(editing: AutomationDefinition, listing: AutomationListing | null): boolean {
  return listing?.entries.some((entry) => entry.definition.id === editing.id) ?? false
}

function isEnabled(entry: AutomationSourceEntry): boolean {
  return entry.source === 'project' ? !entry.locallyDisabled : entry.definition.enabled
}

export function AutomationSection(): React.JSX.Element {
  // The picked server's automations, not this machine's.
  const { shell } = useSettingsShell()
  const env = useSettingsEnvironment()
  const [listing, setListing] = useState<AutomationListing | null>(null)
  const [history, setHistory] = useState<AutomationHistoryEntry[]>([])
  const [editing, setEditing] = useState<AutomationDefinition | null>(null)
  const [viewing, setViewing] = useState<AutomationSourceEntry | null>(null)
  const [deleting, setDeleting] = useState<AutomationDefinition | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [aiAuthorized, setAiAuthorized] = useState(false)
  const [projectPath, setProjectPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let active = true
    void Promise.all([shell.automationListing(projectPath || undefined), shell.automationHistory(), shell.getEnterprisePolicyFull()])
      .then(([nextListing, nextHistory, policy]) => {
        if (!active) return
        setListing(nextListing)
        setHistory(nextHistory)
        setAiAuthorized(deriveEnterpriseAutomationPolicy(policy as EnterprisePolicy | null)?.authorizeAiActions === true)
      })
      .catch((loadError: unknown) => {
        if (!active) return
        setError(String(loadError))
        rWarn('automation.settings', 'automation settings load failed', { error: String(loadError) })
      })
    return () => { active = false }
  }, [projectPath, refreshTick, shell])

  const refresh = (): void => setRefreshTick((t) => t + 1)
  const locked = listing?.locked ?? false

  const save = (definition: AutomationDefinition): void => {
    setError(null)
    void shell.automationUpsert(definition)
      .then((result) => {
        if (!result.ok) {
          setError(result.error ?? 'Could not save workflow')
          rWarn('automation.settings', 'automation save rejected', { error: result.error ?? '' })
          return
        }
        rInfo('automation.settings', 'automation workflow saved', { automation_id: result.definition?.id ?? definition.id })
        setEditing(null)
        refresh()
      })
      .catch((saveError: unknown) => {
        setError(String(saveError))
        rWarn('automation.settings', 'automation save failed', { error: String(saveError) })
      })
  }

  const remove = (id: string): void => {
    void shell.automationDelete(id)
      .then((result) => {
        if (!result.ok) { setError(result.error ?? 'Could not delete workflow'); return }
        rInfo('automation.settings', 'automation workflow deleted', { automation_id: id })
        setDeleting(null)
        refresh()
      })
      .catch((deleteError: unknown) => {
        setError(String(deleteError))
        rWarn('automation.settings', 'automation delete failed', { automation_id: id, error: String(deleteError) })
      })
  }

  const duplicate = (id: string): void => {
    void shell.automationDuplicate(id, projectPath || undefined)
      .then((result) => {
        if (!result.ok || !result.definition) { setError(result.error ?? 'Could not duplicate workflow'); return }
        // Open the fresh user copy for editing immediately.
        setViewing(null)
        setEditing(result.definition)
        refresh()
      })
      .catch((duplicateError: unknown) => {
        setError(String(duplicateError))
        rWarn('automation.settings', 'automation duplicate failed', { automation_id: id, error: String(duplicateError) })
      })
  }

  const toggleProject = (id: string, enabled: boolean): void => {
    void shell.setProjectAutomationEnabled(projectPath, id, enabled)
      .then((result) => {
        if (!result.ok) setError(result.error ?? 'Could not update project workflow')
        else refresh()
      })
      .catch((toggleError: unknown) => {
        setError(String(toggleError))
        rWarn('automation.settings', 'project automation toggle failed', { automation_id: id, error: String(toggleError) })
      })
  }

  const toggle = (entry: AutomationSourceEntry): void => {
    if (entry.source === 'user') save({ ...entry.definition, enabled: !entry.definition.enabled })
    else toggleProject(entry.definition.id, !isEnabled(entry))
  }

  const open = (entry: AutomationSourceEntry): void => {
    if (entry.source === 'user' && !locked) setEditing(entry.definition)
    else setViewing(entry)
  }

  return (
    <Stack gap={20}>
      {locked && <Notice tone="warn">Enterprise policy locks changes to your workflows.</Notice>}
      <ErrorText>{error}</ErrorText>
      <FormGroup title="Scope">
        <FormRow label="Project directory" description="Optional. Project workflows come from this project's .ion/automation folder. Leave blank to manage only your own workflows.">
          <TextInput aria-label="Automation project directory" mono width={240} value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="/path/to/project" spellCheck={false} />
          {projectPath && <Button onClick={() => setProjectPath('')}>Clear</Button>}
        </FormRow>
        <FormRow label="AI actions" description="Whether enterprise policy pre-authorizes automations that run AI actions.">
          <Chip tone={aiAuthorized ? 'accent' : 'warn'}>{aiAuthorized ? 'AI automation authorized' : 'AI automation needs confirmation'}</Chip>
        </FormRow>
      </FormGroup>
      <DataList
        label="Automations"
        title="Automations"
        description={`Workflows watch for events, check optional conditions, then run actions. They and their activity history stay on ${env.label}.`}
        anchor="automations"
        items={listing?.entries ?? []}
        loading={listing === null}
        getKey={(e) => `${e.source}:${e.definition.id}`}
        noun={['automation', 'automations']}
        filter={(e, q) => e.definition.name.toLowerCase().includes(q)}
        isMuted={(e) => !e.effective}
        showHeader
        onRowClick={open}
        columns={[
          {
            id: 'enabled', width: '34px', render: (e) => (
              <div onClick={(ev) => ev.stopPropagation()}>
                <Switch label={`Enable ${e.definition.name}`} checked={isEnabled(e)} disabled={locked || e.source === 'enterprise' || e.source === 'built-in'} onChange={() => toggle(e)} />
              </div>
            ),
          },
          { id: 'name', header: 'Name', width: 'minmax(0, 1fr)', render: (e) => <CellText>{e.definition.name}</CellText> },
          { id: 'when', header: 'When', width: 'minmax(0, 1fr)', render: (e) => <CellText muted>{triggerLabel(e.definition.trigger.event)}</CellText> },
          {
            id: 'source', header: 'Source', render: (e) => <>
              <Chip>{sourceLabel(e.source)}</Chip>
              {e.overriddenBy && <Chip tone="warn">overridden by {sourceLabel(e.overriddenBy)}</Chip>}
            </>,
          },
        ]}
        rowMenu={(e) => [
          e.source === 'user' && !locked && { label: 'Edit', icon: PencilSimple, onSelect: () => setEditing(e.definition) },
          !locked && { label: 'Duplicate', icon: Copy, onSelect: () => duplicate(e.definition.id) },
          e.source === 'user' && !locked && { label: 'Delete', icon: Trash, danger: true, onSelect: () => setDeleting(e.definition) },
        ]}
        actions={!locked && <>
          <Button icon={Sparkle} onClick={() => setTemplatesOpen(true)}>From template</Button>
          <Button variant="primary" icon={Plus} onClick={() => setEditing(blankAutomation())}>New automation</Button>
        </>}
        empty={<EmptyState icon={Lightning} title="No workflows yet." detail="Create one, or start from a template." />}
      />
      <AutomationActivityList history={history} nameFor={(id) => listing?.entries.find((e) => e.definition.id === id)?.definition.name ?? id} />

      <AutomationEditorPanel
        definition={editing}
        title={editing && isSavedEntry(editing, listing) ? `Edit ${editing.name || 'automation'}` : 'New automation'}
        error={error}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
      <SidePanel open={templatesOpen} title="Start from a template" subtitle="Opens a new automation filled in from the template. Nothing is saved until you save it." onClose={() => setTemplatesOpen(false)}>
        <Stack gap={6}>
          {AUTOMATION_TEMPLATES.map((template) => (
            <Button key={template.id} block onClick={() => { setTemplatesOpen(false); setEditing(template.definition()) }}>Use {template.label}</Button>
          ))}
        </Stack>
      </SidePanel>
      <SidePanel
        open={viewing !== null}
        title={viewing?.definition.name ?? ''}
        subtitle={viewing ? `${sourceLabel(viewing.source)} automation. Read-only here; duplicate it to make your own copy.` : undefined}
        onClose={() => setViewing(null)}
        footer={viewing && !locked ? <Button variant="primary" icon={Copy} onClick={() => duplicate(viewing.definition.id)}>Duplicate</Button> : undefined}
      >
        {viewing && (
          <Stack gap={8}>
            <Muted>When: {triggerLabel(viewing.definition.trigger.event)}</Muted>
            <Muted>Then: {actionSummary(viewing.definition.steps ?? viewing.definition.actions ?? [])}</Muted>
            {viewing.overriddenBy && <Muted>Overridden by {sourceLabel(viewing.overriddenBy)}.</Muted>}
          </Stack>
        )}
      </SidePanel>
      <SidePanel
        open={deleting !== null}
        title={`Delete ${deleting?.name || 'automation'}?`}
        subtitle={`Removes this workflow from ${env.label}.`}
        onClose={() => setDeleting(null)}
        footer={<>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" icon={Trash} onClick={() => { if (deleting) remove(deleting.id) }}>Delete</Button>
        </>}
      >
        <ErrorText>{error}</ErrorText>
      </SidePanel>
    </Stack>
  )
}
