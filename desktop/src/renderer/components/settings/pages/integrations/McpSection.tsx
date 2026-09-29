/**
 * McpSection — the MCP servers the picked server's engine is configured
 * with. A thin consumer of the engine's mcp_* verbs: the engine owns config
 * CRUD, OAuth discovery, the PKCE exchange, and token storage. This section
 * shows the state of every server and drives the browser handoff.
 *
 * The list is read on mount and after every change, and the section also
 * follows the `ion:mcp-servers-changed` broadcast, a complete snapshot sent on
 * every MCP transition from any client (an `ion mcp login` in a terminal). A
 * snapshot REPLACES the list, never merges, and clears a stale error.
 *
 * Connected and authorized stay separate indicators: a server that holds a
 * token but is not connected is refusing it, and that is the state to act on.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { PencilSimple, Plugs, Plus, SignIn, SignOut, Trash } from '@phosphor-icons/react'
import type { McpServerStatus } from '@ion/shared/types-engine-event'
import { useSettingsShell } from '../../settings-shell'
import { useSettingsEnvironment } from '../../settings-servers'
import { describeMcpActionError } from './mcp-action-error'
import {
  Button, CellText, Chip, DataList, EmptyState, ErrorText, Field, MonoLine, Muted, Notice, SidePanel, Stack, StatusDot, Inline,
} from '../../kit'
import { rError, rInfo } from '../../../../rendererLogger'
import type { McpAddRequest, McpUpdateRequest } from '@ion/shared/mcp-admin-requests'
import { McpServerFormPanel } from './McpServerFormPanel'
import { signInFromThisMachine } from './mcp-remote-sign-in'
import { host } from '../../../../host/host-instance'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

function endpointOf(server: McpServerStatus): string {
  return server.url || server.command || ''
}

function connectionLabel(server: McpServerStatus): string {
  if (server.connected) return 'connected'
  return server.lastError ? `not connected: ${server.lastError}` : 'not connected'
}

export function McpSection(): React.JSX.Element {
  // The picked server's MCP servers, not this machine's.
  const { shell, on, environmentId } = useSettingsShell()
  const serverLabel = useSettingsEnvironment().label
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  /** Server name currently mid-operation, or '' for a global (add) operation. */
  const [busyName, setBusyName] = useState<string | null>(null)
  const [authorizingName, setAuthorizingName] = useState<string | null>(null)
  const [panel, setPanel] = useState<{ kind: 'add' } | { kind: 'detail' | 'edit' | 'remove'; name: string } | null>(null)
  /** Outcome of the last edit worth telling the operator about. */
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await shell.mcpList()
    if (!result.ok) {
      setErrorMsg(result.error ?? 'Could not load MCP servers')
      return
    }
    setServers(result.servers ?? [])
    setErrorMsg(null)
  }, [shell])

  useEffect(() => {
    void refresh()
      .catch((err) => {
        rError('settings', 'mcp list failed', { error: String(err) })
        setErrorMsg(describeMcpActionError(err, 'Could not load MCP servers', serverLabel))
      })
      .finally(() => setLoading(false))
  }, [refresh, serverLabel])

  useEffect(() => {
    return on('ion:mcp-servers-changed', (payload) => {
      if (!Array.isArray(payload)) return
      const snapshot = payload as McpServerStatus[]
      rInfo('settings', 'mcp servers snapshot received', { count: snapshot.length, environment_id: environmentId })
      setServers(snapshot)
      setErrorMsg(null)
      setLoading(false)
    })
  }, [on, environmentId])

  const handleAdd = useCallback((request: McpAddRequest): Promise<boolean> => {
    setBusyName('')
    setErrorMsg(null)
    return shell
      .mcpAdd(request)
      .then(async (result) => {
        if (!result.ok) {
          setErrorMsg(result.error ?? `Could not add "${request.name}"`)
          return false
        }
        rInfo('settings', 'mcp server added', { name: request.name })
        await refresh()
        return true
      })
      .catch((err) => {
        rError('settings', 'mcp add failed', { name: request.name, error: String(err) })
        setErrorMsg(describeMcpActionError(err, `Could not add "${request.name}"`, serverLabel))
        return false
      })
      .finally(() => setBusyName(null))
  }, [refresh, serverLabel, shell])

  const handleUpdate = useCallback((request: McpUpdateRequest): Promise<boolean> => {
    setBusyName(request.name)
    setErrorMsg(null)
    setNotice(null)
    return shell
      .mcpUpdate(request)
      .then(async (result) => {
        if (!result.ok) {
          setErrorMsg(result.error ?? `Could not save "${request.name}"`)
          return false
        }
        rInfo('settings', 'mcp server updated', { name: request.name, changed: result.changed === true, credentials_cleared: result.credentialsCleared === true })
        if (result.credentialsCleared) setNotice(`${request.name} was updated. Its old sign-in no longer applies, so authorize it again.`)
        await refresh()
        return true
      })
      .catch((err) => {
        rError('settings', 'mcp update failed', { name: request.name, error: String(err) })
        setErrorMsg(describeMcpActionError(err, `Could not save "${request.name}"`, serverLabel))
        return false
      })
      .finally(() => setBusyName(null))
  }, [refresh, serverLabel, shell])

  const handleAuthorize = useCallback((name: string) => {
    setBusyName(name)
    setAuthorizingName(name)
    setErrorMsg(null)
    setNotice(null)
    // A server on another machine would open the browser there, so this
    // machine opens the page and catches the redirect itself. Either way the
    // call resolves only after the operator finishes in the browser (or the
    // flow times out), so the pending state is held for the whole round trip.
    const fromThisMachine = environmentId !== LOCAL_ENVIRONMENT_ID && host.capabilities().includes('nativeShell')
    rInfo('settings', 'mcp authorize started', { name, environment_id: environmentId, from_this_machine: fromThisMachine })
    const signIn = fromThisMachine
      ? signInFromThisMachine(shell, (url) => host.openExternal(url), name)
      : shell.mcpLogin(name)
    void signIn
      .then(async (result) => {
        if (!result.ok) {
          setErrorMsg(result.error ?? `Authorization for "${name}" did not complete`)
          return
        }
        rInfo('settings', 'mcp server authorized', { name })
        await refresh()
      })
      .catch((err) => {
        rError('settings', 'mcp login failed', { name, error: String(err) })
        setErrorMsg(describeMcpActionError(err, `Authorization for "${name}" did not complete`, serverLabel))
      })
      .finally(() => {
        setBusyName(null)
        setAuthorizingName(null)
      })
  }, [environmentId, refresh, serverLabel, shell])

  const handleSignOut = useCallback((name: string) => {
    setBusyName(name)
    void shell
      .mcpLogout(name)
      .then(async (result) => {
        if (!result.ok) {
          setErrorMsg(result.error ?? `Could not sign out of "${name}"`)
          return
        }
        await refresh()
      })
      .catch((err) => {
        rError('settings', 'mcp logout failed', { name, error: String(err) })
        setErrorMsg(describeMcpActionError(err, `Could not sign out of "${name}"`, serverLabel))
      })
      .finally(() => setBusyName(null))
  }, [refresh, serverLabel, shell])

  const handleRemove = useCallback((name: string) => {
    setBusyName(name)
    void shell
      .mcpRemove(name)
      .then(async (result) => {
        if (!result.ok) {
          setErrorMsg(result.error ?? `Could not remove "${name}"`)
          return
        }
        rInfo('settings', 'mcp server removed', { name })
        setPanel(null)
        await refresh()
      })
      .catch((err) => {
        rError('settings', 'mcp remove failed', { name, error: String(err) })
        setErrorMsg(describeMcpActionError(err, `Could not remove "${name}"`, serverLabel))
      })
      .finally(() => setBusyName(null))
  }, [refresh, serverLabel, shell])

  const selected = panel && panel.kind !== 'add' ? servers.find((s) => s.name === panel.name) ?? null : null
  const authorizing = authorizingName && <Notice tone="accent">A browser window has opened — complete sign-in for {authorizingName} there…</Notice>

  return (
    <Stack gap={10}>
      {authorizing}
      {notice && <Notice tone="warn">{notice}</Notice>}
      <ErrorText>{errorMsg}</ErrorText>
      <DataList
        label="MCP servers"
        title="MCP servers"
        description="Model Context Protocol servers extend conversations with external tools and resources. A server that needs authorization is signed in through your browser; the engine holds the token and refreshes it silently."
        anchor="mcp"
        items={servers}
        loading={loading}
        getKey={(s) => s.name}
        noun={['server', 'servers']}
        filter={(s, q) => s.name.toLowerCase().includes(q) || endpointOf(s).toLowerCase().includes(q)}
        showHeader
        onRowClick={(s) => setPanel({ kind: 'detail', name: s.name })}
        columns={[
          { id: 'name', header: 'Server', width: 'minmax(120px, 1fr)', render: (s) => <><StatusDot tone={s.connected ? 'ok' : s.lastError ? 'warn' : 'muted'} label={connectionLabel(s)} /><CellText>{s.name}</CellText></> },
          { id: 'transport', header: 'Transport', width: '76px', render: (s) => (s.transport ? <Chip>{s.transport}</Chip> : null) },
          { id: 'auth', header: 'Auth', width: '100px', render: (s) => <Chip tone={s.authenticated ? 'ok' : 'muted'}>{s.authenticated ? 'authorized' : 'not authorized'}</Chip> },
          { id: 'tools', header: 'Tools', width: '56px', align: 'end', render: (s) => (s.connected && (s.toolCount ?? 0) > 0 ? <CellText muted>{`${s.toolCount} ${s.toolCount === 1 ? 'tool' : 'tools'}`}</CellText> : null) },
          { id: 'endpoint', header: 'Endpoint', width: 'minmax(0, 1.4fr)', render: (s) => <MonoLine>{endpointOf(s)}</MonoLine> },
        ]}
        rowMenu={(s) => [
          { label: s.authenticated ? 'Re-authorize' : 'Authorize', icon: SignIn, disabled: busyName === s.name, onSelect: () => handleAuthorize(s.name) },
          s.authenticated && { label: 'Sign out', icon: SignOut, disabled: busyName === s.name, onSelect: () => handleSignOut(s.name) },
          { label: 'Edit', icon: PencilSimple, disabled: busyName === s.name, onSelect: () => { setErrorMsg(null); setPanel({ kind: 'edit', name: s.name }) } },
          { label: 'Remove', icon: Trash, danger: true, disabled: busyName === s.name, onSelect: () => setPanel({ kind: 'remove', name: s.name }) },
        ]}
        actions={<Button variant="primary" icon={Plus} onClick={() => { setErrorMsg(null); setPanel({ kind: 'add' }) }}>Add server</Button>}
        empty={<EmptyState icon={Plugs} title="No MCP servers configured yet." detail="Add a remote URL or a local command. The engine connects it on the next conversation." />}
      />
      <McpDetailPanel
        server={panel?.kind === 'detail' ? selected : null}
        busy={selected !== null && busyName === selected.name}
        notice={authorizing}
        error={errorMsg}
        onClose={() => setPanel(null)}
        onAuthorize={handleAuthorize}
        onSignOut={handleSignOut}
        onEdit={(name) => { setErrorMsg(null); setPanel({ kind: 'edit', name }) }}
        onRemove={(name) => setPanel({ kind: 'remove', name })}
      />
      <McpRemovePanel
        server={panel?.kind === 'remove' ? selected : null}
        busy={selected !== null && busyName === selected.name}
        error={errorMsg}
        onClose={() => setPanel(null)}
        onRemove={handleRemove}
      />
      <McpServerFormPanel server={null} open={panel?.kind === 'add'} busy={busyName === ''} error={errorMsg} onClose={() => setPanel(null)} onAdd={handleAdd} onUpdate={handleUpdate} />
      {panel?.kind === 'edit' && selected && (
        <McpServerFormPanel key={selected.name} server={selected} open busy={busyName === selected.name} error={errorMsg} onClose={() => setPanel(null)} onAdd={handleAdd} onUpdate={handleUpdate} />
      )}
    </Stack>
  )
}

function McpDetailPanel({ server, busy, notice, error, onClose, onAuthorize, onSignOut, onEdit, onRemove }: {
  server: McpServerStatus | null
  busy: boolean
  notice: React.ReactNode
  error: string | null
  onClose(): void
  onAuthorize(name: string): void
  onSignOut(name: string): void
  onEdit(name: string): void
  onRemove(name: string): void
}): React.JSX.Element | null {
  if (!server) return null
  const endpoint = endpointOf(server)
  return (
    <SidePanel
      open
      title={server.name}
      subtitle={server.transport ? `${server.transport} server` : undefined}
      onClose={onClose}
      footer={<>
        <Button variant="danger" icon={Trash} disabled={busy} onClick={() => onRemove(server.name)}>Remove</Button>
        <Button icon={PencilSimple} disabled={busy} onClick={() => onEdit(server.name)}>Edit</Button>
        {server.authenticated && <Button icon={SignOut} disabled={busy} onClick={() => onSignOut(server.name)}>Sign out</Button>}
        <Button variant="primary" icon={SignIn} disabled={busy} onClick={() => onAuthorize(server.name)}>{server.authenticated ? 'Re-authorize' : 'Authorize'}</Button>
      </>}
    >
      <Stack>
        {notice}
        {endpoint && <Field label="Endpoint"><Muted mono>{endpoint}</Muted></Field>}
        <Field label="Status">
          <Inline wrap>
            <Chip tone={server.connected ? 'ok' : 'muted'}>{server.connected ? 'connected' : 'not connected'}</Chip>
            <Chip tone={server.authenticated ? 'ok' : 'muted'}>{server.authenticated ? 'authorized' : 'not authorized'}</Chip>
            {server.connected && (server.toolCount ?? 0) > 0 && <Muted>{server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}</Muted>}
          </Inline>
        </Field>
        {server.transport !== 'stdio' && (
          <Field label="OAuth client">
            {server.oauth?.clientId ? <Muted mono>{server.oauth.clientId}</Muted> : <Muted>From discovery</Muted>}
          </Field>
        )}
        {server.lastError && <Field label="Last error"><Notice tone="warn">{server.lastError}</Notice></Field>}
        <ErrorText>{error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}

function McpRemovePanel({ server, busy, error, onClose, onRemove }: {
  server: McpServerStatus | null
  busy: boolean
  error: string | null
  onClose(): void
  onRemove(name: string): void
}): React.JSX.Element | null {
  const env = useSettingsEnvironment()
  if (!server) return null
  return (
    <SidePanel
      open
      title={`Remove ${server.name}?`}
      subtitle={`Removes it from the MCP configuration on ${env.label}.`}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" icon={Trash} disabled={busy} onClick={() => onRemove(server.name)}>{busy ? 'Removing…' : 'Remove server'}</Button>
      </>}
    >
      <Stack>
        <Muted>Conversations started after this no longer get {server.name}&apos;s tools. You can add it again later.</Muted>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
