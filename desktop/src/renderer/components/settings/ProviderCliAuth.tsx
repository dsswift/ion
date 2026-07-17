import React, { useState } from 'react'
import type { ProviderEntry } from '../../../shared/types-models'
import { useModelStore } from '../../stores/model-store'
import type { Colors } from './provider-styles'
import { Spinner, linkBtn } from './provider-styles'
import { CLI_INSTALL_GUIDANCE, providerCliBackend } from './provider-auth-labels'

/**
 * Auth surface for a provider with a delegated CLI backend option
 * (codex/grok/cursor, or claude-code). Renders one of:
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

  const kind = providerCliBackend(provider.id)
  if (!kind) return null
  const cli = provider.cli
  const guidance = CLI_INSTALL_GUIDANCE[kind]

  // Not installed: show install guidance.
  if (cli && !cli.installed) {
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
            {copied && <span style={{ marginLeft: 6, color: '#22c55e' }}>copied</span>}
          </>
        ) : (
          <span>Install the {guidance?.name || kind} CLI, then press ↻ Models.</span>
        )}
      </div>
    )
  }

  // Installed + authenticated: show account + sign out.
  if (cli?.authenticated) {
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
        style={{ padding: '6px 14px', background: colors.accent, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
      >
        Sign in with {guidance?.name || kind}
      </button>
      {loginState?.phase === 'error' && (
        <span style={{ marginLeft: 8, fontSize: 11, color: '#ef4444' }}>{loginState.error}</span>
      )}
    </div>
  )
}
