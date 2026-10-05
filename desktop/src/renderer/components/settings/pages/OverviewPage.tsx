/**
 * OverviewPage — one server at a glance: how this device reaches it and
 * whether it is reaching it now, the server, engine, and host behind it, and
 * the verbs that act on its services (Restart, Update, Remove). Right after
 * the server was added, a notice walks the first setup steps.
 */
import React, { useState } from 'react'
import { ArrowClockwise, PencilSimple } from '@phosphor-icons/react'
import { environmentClient, useEnvironmentResource } from '../environment/environment-client'
import { useSettingsEnvironment } from '../settings-servers'
import { useSettingsNav } from '../settings-nav'
import { describeReach, phaseStatus, usePhase } from '../server-status'
import { Button, ErrorText, FormGroup, FormRow, Inline, MonoLine, Muted, Notice, Stack, StatusDot } from '../kit'
import { host } from '../../../host/host-instance'
import { rInfo, rWarn } from '../../../rendererLogger'
import { RemoveServerPanel } from './RemoveServerPanel'
import { RenameServerPanel } from './RenameServerPanel'

export function OverviewPage(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const { navigate } = useSettingsNav()
  const [panel, setPanel] = useState<'rename' | 'remove' | null>(null)
  return (
    <Stack gap={20}>
      {env.justAdded && (
        <Notice tone="accent" action={<Inline>
          <Button variant="ghost" onClick={() => navigate({ pageId: 'git-access', environmentId: env.id, anchor: null })}>Git access</Button>
          <Button variant="ghost" onClick={() => navigate({ pageId: 'projects', environmentId: env.id, anchor: null })}>Projects</Button>
        </Inline>}>
          <strong>Finish setting up {env.label}</strong>
          <div>Give it git access, then add the projects you want there. Copy from another environment clones what this Mac already has.</div>
        </Notice>
      )}
      <ConnectionGroup onRename={() => setPanel('rename')} />
      <ServerFactsGroup onRemove={() => setPanel('remove')} />
      <RenameServerPanel entry={panel === 'rename' ? env.entry : null} onClose={() => setPanel(null)} />
      <RemoveServerPanel entry={panel === 'remove' ? env.entry : null} onClose={() => setPanel(null)} />
    </Stack>
  )
}

function ConnectionGroup({ onRename }: { onRename(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const phase = usePhase(env.id)
  const status = phaseStatus(env.id, phase)
  return (
    <FormGroup
      title="Connection"
      anchor="connection"
      actions={!env.isLocal ? (
        <Button icon={ArrowClockwise} onClick={() => { rInfo('connection-section', 'reconnect requested', { environment_id: env.id }); host.restartEnvironment(env.id) }}>Reconnect</Button>
      ) : undefined}
    >
      <FormRow label="Name" description={env.label}>
        {!env.isLocal && <Button icon={PencilSimple} onClick={onRename}>Rename</Button>}
      </FormRow>
      <FormRow label="Status">
        <Inline><StatusDot tone={status.tone} /><Muted>{status.label}{phase?.reason ? ` · ${phase.reason}` : ''}</Muted></Inline>
      </FormRow>
      <FormRow label="Reached via">
        <Muted>{env.isLocal ? 'The server on this Mac' : describeReach(env.entry.target)}</Muted>
      </FormRow>
    </FormGroup>
  )
}

function ServerFactsGroup({ onRemove }: { onRemove(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const info = useEnvironmentResource(env.id, environmentClient.serverInfo)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const data = info.data
  // A bundle install runs its own command; a server a desktop runs asks that desktop.
  const selfInstalls = !!data?.bundle || !!data?.hostApp
  const whyNot = selfInstalls ? undefined : 'This server was started by hand, so nothing here can restart or update it'

  const schedule = (label: string, fn: () => Promise<{ scheduled: boolean }>): void => {
    setError(null); setNotice(null)
    fn().then(() => {
      rInfo('server-section', 'studio command scheduled', { environment_id: env.id, operation: label })
      setNotice(`${label}. ${env.label} will drop and reconnect in a moment.`)
    }).catch((err: unknown) => {
      rWarn('server-section', 'studio command failed', { environment_id: env.id, operation: label, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <>
      <FormGroup title="Server" description={`The Studio server and engine on ${env.label}.`} anchor="server-facts">
        {!data ? (
          <FormRow label={info.loading ? 'Reading server facts…' : `Could not read the server${info.error ? `: ${info.error}` : ''}`} />
        ) : [
          <FormRow key="server" label="Server version"><Muted>{data.serverVersion}</Muted></FormRow>,
          <FormRow key="engine" label="Engine"><Muted>{data.engineVersion ?? 'not connected'}</Muted></FormRow>,
          <FormRow key="host" label="Host"><Muted>{data.hostname} · {data.platform}/{data.arch}</Muted></FormRow>,
          <FormRow key="data" label="Data directory"><MonoLine>{data.dataDir}</MonoLine></FormRow>,
          <FormRow key="installed" label="Installed as" description={data.bundle ? `Studio Server bundle ${data.bundle.version.server} (engine ${data.bundle.version.engine}, ${data.bundle.version.node})` : 'not a bundle install (run by a desktop or from a checkout)'} />,
          <FormRow key="uptime" label="Up for"><Muted>{Math.round(data.uptimeSeconds / 60)} min</Muted></FormRow>,
          ...(data.formats ? [
            <FormRow key="host-app" label="Run by"><Muted>{data.hostApp ? `Ion desktop ${data.hostApp.version}` : 'its own service'}</Muted></FormRow>,
            <FormRow key="running" label="Running now"><Muted>{data.runningConversations == null ? 'engine not answering' : `${data.runningConversations} conversation${data.runningConversations === 1 ? '' : 's'}`}</Muted></FormRow>,
            <FormRow key="engine-min" label="Engine minimum" description={data.engineMeetsMin === false ? `The running engine is below ${data.engineMinVersion}.` : undefined}><Muted>{!data.engineMinVersion || data.engineMinVersion === '0.0.0' ? 'none' : data.engineMinVersion}</Muted></FormRow>,
            <FormRow key="formats" label="Formats" description="The data formats and protocols this server and its engine speak. Two servers transfer conversations only when their transfer archive versions match."><MonoLine>{data.formats.map((f) => `${f.owner}/${f.id} ${f.version}`).join(' · ')}</MonoLine></FormRow>,
          ] : [
            <FormRow key="formats" label="Formats" description="This server predates format reporting; update it to see its formats." />,
          ]),
        ]}
      </FormGroup>
      <FormGroup title="Lifecycle" anchor="server-lifecycle">
        <FormRow label="Restart" description={data?.hostApp ? 'Restart Ion on the host. Its running conversations stop.' : 'Restart the Studio Server services on the host.'}>
          <Button disabled={!selfInstalls} tooltip={whyNot} onClick={() => schedule('Restart scheduled', () => environmentClient.restart(env.id))}>Restart</Button>
        </FormRow>
        <FormRow label="Update" description={data?.hostApp ? 'Install the newest Ion release on the host.' : 'Update the Studio Server bundle on the host.'}>
          <Button disabled={!selfInstalls} tooltip={whyNot} onClick={() => schedule('Update scheduled', () => environmentClient.update(env.id))}>Update</Button>
        </FormRow>
        {!env.isLocal && (
          <FormRow label="Remove" description="Forget it on this device, or uninstall Ion from the host.">
            <Button variant="danger" onClick={onRemove}>Remove…</Button>
          </FormRow>
        )}
      </FormGroup>
      {notice && <Notice>{notice}</Notice>}
      <ErrorText>{error}</ErrorText>
    </>
  )
}
