/**
 * ProviderCliSignIn — the delegated-CLI sign-in of a provider that has one
 * (Claude Code, Codex, Grok, Cursor): still checking, install guidance, the
 * sign-in button with its live login state, the pasted authorization code,
 * or the signed-in account with Switch account and Sign out. Switch account
 * runs the same sign-in over the account that is there, which stays signed
 * in until the new sign-in finishes.
 *
 * Shown for every provider with a CLI option whatever backend is winning
 * now: signing in is how the CLI routing path is enabled, and Sign out must
 * stay reachable while an API key wins routing.
 */
import React, { useState } from 'react'
import { Copy } from '@phosphor-icons/react'
import type { ProviderEntry } from '@ion/shared/types-models'
import { useModelStore, canStartProviderLogin } from '@ion/server/store/model-store'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { rError, rWarn } from '../../../../rendererLogger'
import { CLI_INSTALL_GUIDANCE, providerCliBackend } from '../../provider-auth-labels'
import { Button, ErrorText, FormGroup, FormRow, IconButton, Inline, MonoLine, Stack, TextInput } from '../../kit'

export function ProviderCliSignIn({ provider, environmentId, title = 'CLI sign-in' }: { provider: ProviderEntry; environmentId: string; title?: string }): React.JSX.Element | null {
  const loginState = useModelStore((s) => s.loginStates[environmentId]?.[provider.id])
  const onHost = useModelStore((s) => s.onHost[environmentId] === true)
  const loginPossibleHere = canStartProviderLogin(onHost, provider)
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  const kind = providerCliBackend(provider.id)
  if (!kind) return null
  const cli = provider.cli
  const cliName = CLI_INSTALL_GUIDANCE[kind]?.name || kind
  const installCmd = CLI_INSTALL_GUIDANCE[kind]?.installCmd

  /** Runs one sign-in verb on the page's server; a failure is logged, never dropped. */
  const run = (verb: string, fn: () => Promise<unknown>): void => {
    void withTargetEnvironment(environmentId, fn).catch((err: unknown) => rError('settings', 'provider cli action failed', { environment_id: environmentId, provider: provider.id, verb, error: String(err) }))
  }
  const cancel = (): void => run('login cancel', () => host.shell.providerLoginCancel(provider.id))

  const submitCode = async (): Promise<void> => {
    const trimmed = code.trim()
    if (!trimmed) return
    setSubmitting(true); setCodeError(null)
    try {
      const res = await withTargetEnvironment(environmentId, () => host.shell.providerLoginCode(provider.id, trimmed))
      if (res.ok) setCode('')
      else setCodeError(res.error || 'Failed to submit code')
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }
  const submit = (): void => { void submitCode().catch((err: unknown) => rError('settings', 'submit auth code failed', { error: String(err) })) }

  const copyInstall = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch((err: unknown) => rWarn('settings', 'copy install command failed', { error: String(err) }))
  }

  let body: React.ReactNode
  // An in-flight login waiting for its pasted code outranks cached probe state.
  if (loginState?.phase === 'await_code') {
    body = (
      <FormRow label="Authorization code" description="Sign in to the account you want on the sign-in page and approve it. The page then shows a code: copy it and paste the authorization code here." stacked>
        <Wide>
        {loginState.url && (
          <Button onClick={() => run('open sign-in page', () => host.openExternal(loginState.url!))}>Open sign-in page</Button>
        )}
        <Inline>
          <TextInput aria-label="Authorization code" placeholder="Authorization code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <Button variant="primary" disabled={submitting || !code.trim()} onClick={submit}>{submitting ? 'Submitting…' : 'Submit'}</Button>
          <Button onClick={cancel}>Cancel</Button>
        </Inline>
        <ErrorText>{codeError}</ErrorText>
        </Wide>
      </FormRow>
    )
  } else if (!cli) {
    // The engine has not probed the CLI yet; a Sign in button here could not succeed.
    body = <FormRow label={`${cliName} CLI`} description={`Checking ${cliName} CLI…`} />
  } else if (!cli.installed) {
    body = (
      <FormRow label={`${cliName} CLI`} description={installCmd ? `${cliName} CLI not installed. Install it on the host:` : `${cliName} CLI not installed. Install the ${cliName} CLI, then refresh models.`} stacked={!!installCmd}>
        {installCmd && (
          <Wide>
            <Inline>
              <MonoLine>{installCmd}</MonoLine>
              <IconButton icon={Copy} label={copied ? 'Copied' : 'Copy install command'} onClick={() => copyInstall(installCmd)} />
            </Inline>
          </Wide>
        )}
      </FormRow>
    )
  } else if (loginState?.phase === 'waiting') {
    body = (
      <FormRow label={`${cliName} CLI`} description={loginState.userCode ? `Enter code ${loginState.userCode} in your browser…` : 'Waiting for browser sign-in…'}>
        <Button onClick={cancel}>Cancel</Button>
      </FormRow>
    )
  } else if (cli.authenticated) {
    body = (
      <FormRow label={`${cliName} CLI`} description={`${cli.label || 'Signed in'}${cli.email ? ` · ${cli.email}` : ''}`} warning={loginState?.phase === 'error' ? loginState.error : undefined}>
        <Inline>
          {loginPossibleHere && <Button onClick={() => run('switch account', () => host.shell.providerLogin(provider.id))}>Switch account</Button>}
          <Button onClick={() => run('logout', () => host.shell.providerLogout(provider.id))}>Sign out</Button>
        </Inline>
      </FormRow>
    )
  } else if (!loginPossibleHere) {
    // The engine says this flow finishes only in a browser on its own host.
    body = <FormRow label={`${cliName} CLI`} description={`Sign in with ${cliName} completes in a browser on the host itself, so it cannot run from here. Sign in on the host, or use an API key.`} />
  } else {
    body = (
      <FormRow label={`${cliName} CLI`} description={loginState?.phase === 'error' ? <ErrorText>{loginState.error}</ErrorText> : 'Installed, not signed in.'}>
        <Button variant="primary" onClick={() => run('login', () => host.shell.providerLogin(provider.id))}>Sign in with {cliName}</Button>
      </FormRow>
    )
  }

  return <FormGroup title={title}>{body}</FormGroup>
}

/** The full-width body of a stacked row. */
export function Wide({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ flex: 1, minWidth: 0 }}><Stack gap={6}>{children}</Stack></div>
}
