import React, { useState } from 'react'
import type { ProviderEntry } from '../../../shared/types-models'
import { useModelStore } from '../../stores/model-store'
import type { Colors } from './provider-styles'
import { Spinner, linkBtn, inputSt, saveBtn } from './provider-styles'
import { CLI_INSTALL_GUIDANCE, providerCliBackend } from './provider-auth-labels'
import { rError } from '../../rendererLogger'

/**
 * Auth surface for a provider with a delegated CLI backend option
 * (codex/grok/cursor, or claude-code). Renders one of:
 *  - a neutral checking state while the engine has not probed the CLI yet;
 *  - install guidance when the CLI binary is missing;
 *  - a Sign in button (+ live login state) when installed but not authed;
 *  - the signed-in account + Sign out when authed.
 *
 * Rendered for every provider with a CLI CAPABILITY, regardless of the
 * currently effective backend: signing in is how the user enables the CLI
 * routing path (credential-derived — no key + authed CLI → CLI backend), and
 * sign-out must stay reachable even while an API key is winning routing.
 */
export function ProviderCliAuth({ provider, colors }: { provider: ProviderEntry; colors: Colors }) {
  const loginState = useModelStore((s) => s.loginStates[provider.id])
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  const kind = providerCliBackend(provider.id)
  if (!kind) return null
  const cli = provider.cli
  const guidance = CLI_INSTALL_GUIDANCE[kind]

  const submitCode = async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setSubmitting(true); setCodeError(null)
    try {
      const res = await window.ion.providerLoginCode(provider.id, trimmed)
      if (res.ok) setCode('')
      else setCodeError(res.error || 'Failed to submit code')
    } catch (err) {
      setCodeError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  // A login parked on await_auth_code: the provider handed the user a code in
  // the browser and the CLI is waiting for it. Checked before the probe/auth
  // branches below because an in-flight login outranks cached probe state.
  if (loginState?.phase === 'await_code') {
    return (
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>
          Approve the sign-in in your browser, then paste the authorization code here.
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Authorization code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitCode().catch((err) => rError('settings', 'submit auth code failed', { error: String(err) })) }}
            style={inputSt(colors)}
          />
          <button
            onClick={() => { void submitCode().catch((err) => rError('settings', 'submit auth code failed', { error: String(err) })) }}
            disabled={submitting || !code.trim()}
            style={saveBtn(colors, submitting || !code.trim())}
          >
            {submitting ? '…' : 'Submit'}
          </button>
          <button onClick={() => void window.ion.providerLoginCancel(provider.id)} style={linkBtn(colors)}>Cancel</button>
        </div>
        {loginState.url && (
          <div style={{ marginTop: 4, fontSize: 10, color: colors.textTertiary }}>
            {/* The CLI opened its own tab; this is its printed fallback URL,
                offered on demand rather than auto-opened (see model-store). */}
            Browser didn’t open?{' '}
            <button onClick={() => void window.ion.openExternal(loginState.url!)} style={linkBtn(colors)}>Open sign-in page</button>
          </div>
        )}
        {codeError && <div style={{ marginTop: 4, fontSize: 11, color: colors.dangerFg }}>{codeError}</div>}
      </div>
    )
  }

  // Not probed yet: the engine has not reported install/auth state for this CLI.
  // Showing a Sign in button here would offer an action that cannot succeed, so
  // the row reports that it is still resolving. (Engine-side, providerCliStatus
  // returns nil until the first probe lands.)
  if (!cli) {
    return (
      <div style={{ marginTop: 4, fontSize: 11, color: colors.textTertiary }}>
        Checking {guidance?.name || kind} CLI…
      </div>
    )
  }

  // Not installed: show install guidance.
  if (!cli.installed) {
    return (
      <div style={{ marginTop: 4, fontSize: 11, color: colors.textTertiary }}>
        <span>{guidance?.name || kind} CLI not installed.</span>{' '}
        {guidance?.installCmd ? (
          <>
            Install with{' '}
            <code
              onClick={() => { void navigator.clipboard.writeText(guidance.installCmd!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              style={{ fontFamily: 'monospace', fontSize: 10, background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '1px 5px', cursor: 'pointer' }}
              title="Click to copy"
            >
              {guidance.installCmd}
            </code>
            {copied && <span style={{ marginLeft: 6, color: colors.successFg }}>copied</span>}
          </>
        ) : (
          <span>Install the {guidance?.name || kind} CLI, then press ↻ Models.</span>
        )}
      </div>
    )
  }

  // Installed + authenticated: show account + sign out.
  if (cli.authenticated) {
    return (
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: colors.textTertiary }}>
          {cli.label || 'Signed in'}{cli.email ? ` · ${cli.email}` : ''}
        </span>
        <button onClick={() => void window.ion.providerLogout(provider.id)} style={linkBtn(colors)}>Sign out</button>
      </div>
    )
  }

  // Installed but not authed: sign-in button + live login state.
  if (loginState?.phase === 'waiting') {
    return (
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: colors.textSecondary }}>
        <Spinner size={12} />
        {loginState.userCode
          ? <span>Enter code <strong style={{ fontFamily: 'monospace' }}>{loginState.userCode}</strong> in your browser…</span>
          : <span>Waiting for browser sign-in…</span>}
        <button onClick={() => void window.ion.providerLoginCancel(provider.id)} style={linkBtn(colors)}>Cancel</button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => void window.ion.providerLogin(provider.id)}
        style={{ padding: '6px 14px', background: colors.accent, color: colors.textOnAccent, border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
      >
        Sign in with {guidance?.name || kind}
      </button>
      {loginState?.phase === 'error' && (
        <span style={{ marginLeft: 8, fontSize: 11, color: colors.dangerFg }}>{loginState.error}</span>
      )}
    </div>
  )
}
