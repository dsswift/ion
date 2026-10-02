/**
 * McpServerFormPanel — the add and edit form for one MCP server.
 *
 * Name plus endpoint; the engine infers the transport (a URL is http, a
 * command is stdio). A remote server may also carry an OAuth client. Every
 * OAuth field is optional: whatever is left blank, the engine fills from the
 * server's discovery metadata at sign-in. Headers and environment variables
 * stay on the CLI (`ion mcp add --header`).
 *
 * An edit sends only what the form shows. The engine keeps every other
 * setting, and the stored client secret unless the operator replaces or
 * removes it: the secret is never sent back to a client, so "keep" is the
 * absence of a value.
 */
import React, { useState } from 'react'
import type { McpServerStatus } from '@ion/shared/types-engine-event'
import type { McpAddRequest, McpOAuthSettings, McpUpdateRequest } from '@ion/shared/mcp-admin-requests'
import { Button, ErrorText, Field, Inline, Muted, Segmented, SidePanel, Stack, Switch, TextInput } from '../../kit'

type ServerKind = 'remote' | 'local'

const NAME_HINT_ERRORS = {
  empty: 'Enter a name for the server.',
  spaces: 'The name cannot contain spaces.',
  separator: 'The name cannot contain "__" (it separates server and tool names).',
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function commandLineOf(server: McpServerStatus): string {
  return [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
}

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

export function McpServerFormPanel({ server, open, busy, error, onClose, onAdd, onUpdate }: {
  /** The server being edited, or null to add a new one. */
  server: McpServerStatus | null
  open: boolean
  busy: boolean
  error: string | null
  onClose(): void
  onAdd(request: McpAddRequest): Promise<boolean>
  onUpdate(request: McpUpdateRequest): Promise<boolean>
}): React.JSX.Element {
  const editing = server !== null
  const [kind, setKind] = useState<ServerKind>(server?.transport === 'stdio' ? 'local' : 'remote')
  const [name, setName] = useState(server?.name ?? '')
  const [endpoint, setEndpoint] = useState(server ? (server.url || commandLineOf(server)) : '')
  const [oauthOn, setOauthOn] = useState(server?.oauth !== undefined)
  const [clientId, setClientId] = useState(server?.oauth?.clientId ?? '')
  const [authUrl, setAuthUrl] = useState(server?.oauth?.authUrl ?? '')
  const [tokenUrl, setTokenUrl] = useState(server?.oauth?.tokenUrl ?? '')
  const [scope, setScope] = useState(server?.oauth?.scope ?? '')
  const [resource, setResource] = useState(server?.oauth?.resource ?? '')
  const [secret, setSecret] = useState('')
  const [secretRemoved, setSecretRemoved] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const storedSecret = server?.oauth?.hasClientSecret === true && !secretRemoved

  const validate = (trimmedName: string, trimmedEndpoint: string): string | null => {
    // Mirrors the engine's own rules so the operator is corrected here rather
    // than by a round trip: "__" is the MCP tool-name separator.
    if (!editing) {
      if (trimmedName === '') return NAME_HINT_ERRORS.empty
      if (/\s/.test(trimmedName)) return NAME_HINT_ERRORS.spaces
      if (trimmedName.includes('__')) return NAME_HINT_ERRORS.separator
    }
    if (trimmedEndpoint === '') return kind === 'remote' ? 'Enter the server URL.' : 'Enter the command to run.'
    if (kind === 'remote' && !isHttpUrl(trimmedEndpoint)) return 'The URL must start with http:// or https://'
    if (kind !== 'remote' || !oauthOn) return null
    if (clientId.trim() === '' && (authUrl.trim() || tokenUrl.trim() || secret.trim())) {
      return 'Enter the client ID. An authorization URL, token URL, or secret belongs to a client.'
    }
    if (authUrl.trim() && !isHttpUrl(authUrl.trim())) return 'The authorization URL must start with http:// or https://'
    if (tokenUrl.trim() && !isHttpUrl(tokenUrl.trim())) return 'The token URL must start with http:// or https://'
    return null
  }

  /** The OAuth client the form describes, or undefined when it leaves the stored one alone. */
  const oauthSettings = (): McpOAuthSettings | undefined => {
    if (kind !== 'remote') return undefined
    if (!oauthOn) {
      // Switching the client off on an edit clears the configured block,
      // secret included; on an add there is nothing to send.
      return server?.oauth ? { clientSecret: '' } : undefined
    }
    const settings: McpOAuthSettings = {}
    const fields: Array<[keyof McpOAuthSettings, string]> = [['clientId', clientId], ['authUrl', authUrl], ['tokenUrl', tokenUrl], ['scope', scope], ['resource', resource]]
    for (const [key, value] of fields) if (value.trim()) settings[key] = value.trim()
    if (secret.trim()) settings.clientSecret = secret.trim()
    else if (secretRemoved) settings.clientSecret = ''
    if (!editing && Object.keys(settings).length === 0) return undefined
    return settings
  }

  const submit = (): void => {
    const trimmedName = server ? server.name : name.trim()
    const trimmedEndpoint = endpoint.trim()
    const problem = validate(trimmedName, trimmedEndpoint)
    setValidationError(problem)
    if (problem) return

    const oauth = oauthSettings()
    // A local server is usually pasted as a full command line: split it into
    // the executable plus its arguments.
    const parts = trimmedEndpoint.split(/\s+/)
    let pending: Promise<boolean>
    if (server) {
      const request: McpUpdateRequest = { name: server.name }
      if (kind === 'remote' && trimmedEndpoint !== server.url) request.url = trimmedEndpoint
      if (kind === 'local') {
        if (parts[0] !== server.command) request.command = parts[0]
        if (!sameArgs(parts.slice(1), server.args ?? [])) request.args = parts.slice(1)
      }
      if (oauth) request.oauth = oauth
      pending = onUpdate(request)
    } else {
      const request: McpAddRequest = kind === 'remote'
        ? { name: trimmedName, url: trimmedEndpoint }
        : { name: trimmedName, command: parts[0], args: parts.slice(1) }
      if (oauth) request.oauth = oauth
      pending = onAdd(request)
    }
    void pending.then((saved) => {
      if (!saved) return
      if (!editing) {
        setName('')
        setEndpoint('')
        setOauthOn(false)
        setClientId(''); setAuthUrl(''); setTokenUrl(''); setScope(''); setResource(''); setSecret('')
      }
      onClose()
    })
  }
  const onEnter = (e: React.KeyboardEvent): void => { if (e.key === 'Enter') submit() }
  const input = (label: string, value: string, set: (next: string) => void, placeholder: string, mono = true): React.JSX.Element => (
    <TextInput mono={mono} aria-label={label} value={value} onChange={(e) => set(e.target.value)} onKeyDown={onEnter} placeholder={placeholder} spellCheck={false} />
  )

  return (
    <SidePanel
      open={open}
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      subtitle={editing ? 'Settings not shown here are kept.' : 'It connects on the next conversation you start.'}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>{editing ? (busy ? 'Saving…' : 'Save changes') : (busy ? 'Adding…' : 'Add server')}</Button>
      </>}
    >
      <Stack>
        {!editing && <Segmented<ServerKind> label="Server kind" value={kind} onChange={(next) => { setKind(next); setValidationError(null) }} options={[{ value: 'remote', label: 'Remote URL' }, { value: 'local', label: 'Local command' }]} />}
        {!editing && <Field label="Name">{input('Server name', name, setName, 'Name (e.g. mobbin)', false)}</Field>}
        <Field label={kind === 'remote' ? 'URL' : 'Command'}>
          {input(kind === 'remote' ? 'Server URL' : 'Server command', endpoint, setEndpoint, kind === 'remote' ? 'https://api.example.com/mcp' : 'npx -y @scope/mcp-server')}
        </Field>
        {kind === 'remote' && (
          <Field label="OAuth client" hint="Most servers need none of this. Set a client ID when the sign-in provider cannot register Ion by itself, such as Microsoft Entra. Anything left blank comes from the server's discovery metadata.">
            <Inline gap={8}>
              <Switch label="Set the OAuth client" checked={oauthOn} onChange={setOauthOn} />
              <Muted>{oauthOn ? 'Set here' : 'From discovery'}</Muted>
            </Inline>
          </Field>
        )}
        {kind === 'remote' && oauthOn && <>
          <Field label="Client ID">{input('OAuth client ID', clientId, setClientId, '00000000-0000-0000-0000-000000000000')}</Field>
          <Field label="Client secret" hint="Only for a confidential client. Leave blank for a public client.">
            {storedSecret
              ? <Inline gap={8}>
                  {input('OAuth client secret', secret, setSecret, 'Stored. Type a new one to replace it.')}
                  <Button onClick={() => { setSecret(''); setSecretRemoved(true) }}>Remove</Button>
                </Inline>
              : input('OAuth client secret', secret, setSecret, secretRemoved ? 'Removed when you save' : 'Optional')}
          </Field>
          <Field label="Scope">{input('OAuth scope', scope, setScope, 'api://00000000-0000-0000-0000-000000000000/.default offline_access')}</Field>
          <Field label="Authorization URL">{input('OAuth authorization URL', authUrl, setAuthUrl, 'From discovery')}</Field>
          <Field label="Token URL">{input('OAuth token URL', tokenUrl, setTokenUrl, 'From discovery')}</Field>
          <Field label="Resource">{input('OAuth resource', resource, setResource, 'From discovery')}</Field>
        </>}
        <ErrorText>{validationError ?? error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
