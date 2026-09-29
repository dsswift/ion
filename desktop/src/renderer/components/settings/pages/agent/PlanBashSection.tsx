/**
 * PlanBashSection — the Bash command prefixes the agent may run in plan
 * mode, kept in the server's engine.json and read and written there. The
 * page shows a one-line summary; the list is edited in a side panel.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useSettingsEnvironment } from '../../settings-servers'
import { Button, ErrorText, FormGroup, FormRow, Muted, SidePanel, Stack, StringListEditor } from '../../kit'

const SUMMARY_PREFIXES = 3

/** "3 commands · gh, git status, ls" or the blocked-entirely line. */
export function planBashSummary(commands: readonly string[]): string {
  if (commands.length === 0) return 'None. Bash is blocked entirely in plan mode.'
  const head = commands.slice(0, SUMMARY_PREFIXES).join(', ')
  const more = commands.length > SUMMARY_PREFIXES ? ', …' : ''
  return `${commands.length} ${commands.length === 1 ? 'command' : 'commands'} · ${head}${more}`
}

export function PlanBashSection(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const [commands, setCommands] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let cancelled = false
    withTargetEnvironment(env.id, () => host.shell.getPlanBashAllowlist()).then((list) => { if (!cancelled) setCommands(list) }).catch((err: unknown) => {
      if (cancelled) return
      rWarn('engine-config', 'plan bash allowlist load failed', { environment_id: env.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [env.id])

  const update = useCallback((next: string[]) => {
    setCommands(next)
    setError(null)
    withTargetEnvironment(env.id, () => host.shell.setPlanBashAllowlist(next)).then(() => {
      rInfo('engine-config', 'plan bash allowlist saved', { environment_id: env.id, count: next.length })
    }).catch((err: unknown) => {
      rWarn('engine-config', 'plan bash allowlist save failed', { environment_id: env.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [env.id])

  return (
    <>
      <FormGroup title="Plan mode">
        <FormRow anchor="plan-bash" label="Allowed Bash commands" description={commands === null ? (error ? 'Could not load.' : 'Loading…') : planBashSummary(commands)}>
          <Button disabled={commands === null} onClick={() => setEditing(true)}>Edit</Button>
        </FormRow>
        {error && !editing && <FormRow label="Could not update the list"><ErrorText>{error}</ErrorText></FormRow>}
      </FormGroup>
      <SidePanel open={editing} title="Allowed Bash commands in plan mode" subtitle={`Saved to engine.json on ${env.label}.`} onClose={() => setEditing(false)}>
        <Stack>
          <Muted>Command prefixes the agent may run through Bash while in plan mode. "gh" matches "gh pr view" but not "ghost". An empty list blocks Bash entirely.</Muted>
          <StringListEditor
            label="Allowed Bash commands"
            values={commands ?? []}
            onChange={update}
            placeholder="e.g. gh"
            emptyText="No commands allowed. Bash is blocked entirely in plan mode."
          />
          <ErrorText>{error}</ErrorText>
        </Stack>
      </SidePanel>
    </>
  )
}
