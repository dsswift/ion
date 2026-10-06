/**
 * GitAccessPage — can this server reach your repositories, and who does it
 * commit as. Credentials are the per-principal git identity
 * (`gitIdentity.*`): mint an SSH key on the host for a git host, paste a key
 * or a token instead. The host's own ssh keys and CLI sign-ins are listed
 * beside them, read-only. A test runs `git ls-remote` from the host. The
 * commit author is the host's global git config.
 */
import React, { useState } from 'react'
import { Copy, Key, Trash, Plus, Plugs, ArrowSquareOut } from '@phosphor-icons/react'
import type { EnvironmentGitAuthor, EnvironmentGitTest } from '@ion/shared/types-environment-admin'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { gitIdentityKey, type GitIdentitySummary } from '@ion/shared/types-git-identity'
import { environmentClient, useEnvironmentResource, useEnvironmentProjects } from '../environment/environment-client'
import { useSettingsEnvironment } from '../settings-servers'
import {
  Button, CellText, Chip, DataList, EmptyState, ErrorText, Field, FormGroup, FormRow, MonoLine, Muted, Segmented, SidePanel, Stack, TextArea, TextInput, Inline, StatusDot,
} from '../kit'
import { rInfo, rWarn } from '../../../rendererLogger'
import { host } from '../../../host/host-instance'

const SOURCE_LABEL: Record<Exclude<GitIdentitySummary['source'], 'host'>, string> = {
  admin: 'Managed by your organization',
  'exchange-ado': 'Via Azure DevOps',
  'exchange-gitlab': 'Via GitLab',
  'exchange-github': 'Via GitHub',
  user: 'Set by you',
}

/** Where a credential came from. A host row names the key file on that server, or the CLI that is signed in there. */
function sourceLabel(identity: GitIdentitySummary, serverLabel: string): string {
  if (identity.source !== 'host') return SOURCE_LABEL[identity.source]
  if (identity.tool) return identity.username ? `Signed in with ${identity.tool} as ${identity.username}` : `Signed in with ${identity.tool}`
  return `${identity.file ?? 'ssh key'} in ~/.ssh on ${serverLabel}`
}

type Mode = 'mint' | 'paste-key' | 'token'

/** Runs one git-access operation with a busy flag, an error line, and a log line either way. */
function useOperation(environmentId: string): { busy: boolean; error: string | null; run(label: string, fn: () => Promise<void>): void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (label: string, fn: () => Promise<void>): void => {
    setBusy(true); setError(null)
    fn().then(() => rInfo('git-access', 'operation done', { environment_id: environmentId, operation: label })).catch((err: unknown) => {
      rWarn('git-access', 'operation failed', { environment_id: environmentId, operation: label, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }
  return { busy, error, run }
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text).catch((err: unknown) => rWarn('git-access', 'copy failed', { error: String(err) }))
}

export function GitAccessPage(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const identities = useEnvironmentResource(env.id, environmentClient.gitIdentityList)
  const author = useEnvironmentResource(env.id, environmentClient.gitAuthorGet)
  const op = useOperation(env.id)
  const [panel, setPanel] = useState<'add' | 'test' | 'author' | null>(null)

  return (
    <Stack gap={20}>
      <ErrorText>{op.error}</ErrorText>
      <DataList
        label="Git credentials"
        title="Credentials"
        description={`Keys and tokens ${env.label} uses to reach your repositories.`}
        anchor="credentials"
        items={identities.data ?? []}
        loading={identities.loading}
        getKey={gitIdentityKey}
        noun={['credential', 'credentials']}
        filter={(i, q) => i.host.toLowerCase().includes(q)}
        showHeader
        columns={[
          { id: 'host', header: 'Host', render: (i) => <><Key size={13} /><CellText>{i.host === '*' ? 'Every host' : i.host}</CellText></> },
          { id: 'kind', header: 'Kind', width: '80px', render: (i) => <Chip>{i.kind === 'ssh' ? 'ssh key' : 'token'}</Chip> },
          { id: 'source', header: 'Source', width: '260px', render: (i) => <CellText muted>{sourceLabel(i, env.label)}</CellText> },
        ]}
        rowMenu={(i) => [
          i.publicKey ? { label: 'Copy public key', icon: Copy, onSelect: () => copy(i.publicKey!) } : null,
          i.source === 'host' || i.source === 'admin' ? null : { label: 'Remove', icon: Trash, danger: true, onSelect: () => op.run('credential removed', async () => { await environmentClient.gitIdentityRemove(env.id, i.host); identities.refresh() }) },
        ]}
        actions={<>
          <Button onClick={() => setPanel('test')}>Test access</Button>
          <Button variant="primary" icon={Plus} onClick={() => setPanel('add')}>Add credential</Button>
        </>}
        empty={(
          <EmptyState
            icon={Key}
            title="No git credentials"
            detail={`${env.label} has no key or sign-in for a git host, so private repositories cannot be reached until you add a credential.`}
          />
        )}
      />
      <CommitAuthorGroup author={author} onEdit={() => setPanel('author')} />
      <AddCredentialPanel open={panel === 'add'} onClose={() => setPanel(null)} onAdded={() => identities.refresh()} />
      <TestAccessPanel open={panel === 'test'} onClose={() => setPanel(null)} />
      <CommitAuthorPanel author={author} open={panel === 'author'} onClose={() => setPanel(null)} />
    </Stack>
  )
}

type AuthorResource = ReturnType<typeof useEnvironmentResource<EnvironmentGitAuthor>>

function CommitAuthorGroup({ author, onEdit }: { author: AuthorResource; onEdit(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const set = author.data?.name && author.data.email
  return (
    <FormGroup title="Identity" anchor="commit-author">
      <FormRow label="Commit author" description={set ? `${author.data!.name} <${author.data!.email}>` : author.loading ? 'Loading…' : `Not set on ${env.label}. Commits there will fail until it is.`}>
        <Button onClick={onEdit}>Edit</Button>
      </FormRow>
    </FormGroup>
  )
}

function AddCredentialPanel({ open, onClose, onAdded }: { open: boolean; onClose(): void; onAdded(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const op = useOperation(env.id)
  const [gitHost, setGitHost] = useState('github.com')
  const [mode, setMode] = useState<Mode>('mint')
  const [pastedKey, setPastedKey] = useState('')
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [minted, setMinted] = useState<{ host: string; publicKey: string } | null>(null)
  const hostValue = gitHost.trim()
  const ready = hostValue !== '' && (mode !== 'token' || token !== '') && (mode !== 'paste-key' || pastedKey.trim() !== '')
  const close = (): void => { setMinted(null); onClose() }

  return (
    <SidePanel
      open={open}
      title="Add a git credential"
      subtitle={`Stored on ${env.label} and used for every repository on that host.`}
      onClose={close}
      footer={minted ? <Button variant="primary" onClick={close}>Done</Button> : <>
        <Button icon={Plugs} disabled={op.busy || !hostValue} tooltip="Sign in through the server's GitHub or GitLab app instead of a key; needs the server's git exchange configured" onClick={() => op.run('authorize started', async () => { await environmentClient.gitIdentityAuthorize(env.id, hostValue) })}>Connect via sign-in</Button>
        <Button variant="primary" disabled={op.busy || !ready} onClick={() => op.run('credential added', async () => {
          if (mode === 'mint') {
            const result = await environmentClient.gitIdentityMint(env.id, hostValue)
            setMinted({ host: hostValue, publicKey: result.publicKey })
          } else if (mode === 'paste-key') {
            const result = await environmentClient.gitIdentitySetKey(env.id, hostValue, pastedKey)
            setMinted({ host: hostValue, publicKey: result.publicKey })
            setPastedKey('')
          } else {
            await environmentClient.gitIdentitySetToken(env.id, hostValue, token, username || undefined)
            setToken(''); setUsername('')
            onClose()
          }
          onAdded()
        })}>{op.busy ? 'Working…' : 'Add'}</Button>
      </>}
    >
      {minted ? (
        <Stack>
          <Muted>Key minted on {env.label} for {minted.host}. Add this public key to your account there, then test access.</Muted>
          <TextArea mono readOnly rows={5} value={minted.publicKey} aria-label="Public key" />
          <Inline>
            <Button icon={Copy} onClick={() => copy(minted.publicKey)}>Copy key</Button>
            {minted.host === 'github.com' && <Button icon={ArrowSquareOut} onClick={() => { void host.openExternal('https://github.com/settings/ssh/new').catch((err: unknown) => rWarn('git-access', 'open github failed', { error: String(err) })) }}>Open GitHub SSH keys</Button>}
          </Inline>
        </Stack>
      ) : (
        <Stack>
          <Field label="Git host"><TextInput aria-label="Git host" value={gitHost} onChange={(e) => setGitHost(e.target.value)} placeholder="github.com" spellCheck={false} /></Field>
          <Field label="Credential">
            <Segmented<Mode> label="Credential kind" value={mode} onChange={setMode} options={[{ value: 'mint', label: 'Mint an SSH key' }, { value: 'paste-key', label: 'Paste a key' }, { value: 'token', label: 'Access token' }]} />
          </Field>
          {mode === 'mint' && <Muted>{env.label} makes a new key pair. You add its public key to your account on {hostValue || 'the git host'}.</Muted>}
          {mode === 'paste-key' && <Field label="SSH private key"><TextArea mono aria-label="SSH private key" value={pastedKey} onChange={(e) => setPastedKey(e.target.value)} rows={6} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></Field>}
          {mode === 'token' && <>
            <Field label="Token"><TextInput aria-label="Access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
            <Field label="Username" hint="Optional. Some hosts need it with a token."><TextInput aria-label="Token username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          </>}
          <ErrorText>{op.error}</ErrorText>
        </Stack>
      )}
    </SidePanel>
  )
}

function TestAccessPanel({ open, onClose }: { open: boolean; onClose(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const projects = useEnvironmentProjects(env.id)
  const op = useOperation(env.id)
  const [testUrl, setTestUrl] = useState('')
  const [tests, setTests] = useState<EnvironmentGitTest[]>([])
  const url = testUrl || projects.data?.find((p) => p.originUrl)?.originUrl || ''
  return (
    <SidePanel open={open} title="Test repository access" subtitle={`Runs git ls-remote on ${env.label} with its stored credentials.`} onClose={onClose}>
      <Stack>
        <Field label="Repository URL">
          <Inline>
            <TextInput aria-label="Repository URL to test" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder={url || 'git@github.com:org/repo.git'} spellCheck={false} />
            <Button variant="primary" disabled={op.busy || !url} onClick={() => op.run('remote tested', async () => {
              const result = await environmentClient.gitTest(env.id, url)
              // One result per URL: a passing retest replaces the earlier refusal instead of stacking under it.
              setTests((prev) => [result, ...prev.filter((t) => t.url !== result.url)].slice(0, 5))
            })}>{op.busy ? 'Testing…' : 'Test'}</Button>
          </Inline>
        </Field>
        <ErrorText>{op.error}</ErrorText>
        {tests.map((t) => (
          <div key={t.url} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ paddingTop: 4 }}><StatusDot tone={t.ok ? 'ok' : 'error'} /></span>
            <div style={{ minWidth: 0 }}>
              <MonoLine>{t.url}</MonoLine>
              <Muted>{t.ok ? `Reachable · ${t.defaultBranch ?? 'HEAD'} · ${t.durationMs} ms` : `Refused: ${t.error}`}</Muted>
            </div>
          </div>
        ))}
      </Stack>
    </SidePanel>
  )
}

function CommitAuthorPanel({ author, open, onClose }: { author: AuthorResource; open: boolean; onClose(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const op = useOperation(env.id)
  const [name, setName] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const effectiveName = name ?? author.data?.name ?? ''
  const effectiveEmail = email ?? author.data?.email ?? ''
  return (
    <SidePanel
      open={open}
      title="Commit author"
      subtitle={`The global git name and email on ${env.label}.`}
      onClose={onClose}
      footer={<>
        {env.id !== LOCAL_ENVIRONMENT_ID && (
          <Button disabled={op.busy} onClick={() => op.run('author copied from this Mac', async () => {
            const local = await environmentClient.gitAuthorGet(LOCAL_ENVIRONMENT_ID)
            if (!local.name || !local.email) throw new Error('this Mac has no global git name and email set')
            setName(local.name); setEmail(local.email)
          })}>Copy from this Mac</Button>
        )}
        <Button variant="primary" disabled={op.busy || !effectiveName.trim() || !effectiveEmail.trim()} onClick={() => op.run('author saved', async () => {
          await environmentClient.gitAuthorSet(env.id, { name: effectiveName, email: effectiveEmail })
          setName(null); setEmail(null); author.refresh(); onClose()
        })}>Save</Button>
      </>}
    >
      <Stack>
        <Field label="Name"><TextInput aria-label="Git author name" value={effectiveName} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email"><TextInput aria-label="Git author email" value={effectiveEmail} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.org" /></Field>
        <ErrorText>{op.error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
