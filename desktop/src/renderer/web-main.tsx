/**
 * Entry point for the browser Studio client (spec 18): the same
 * `StudioShell` the Electron Studio window mounts, running against
 * `BrowserStudioHost` instead of the preload bridge (`host-instance.ts`
 * picks the host by whether `window.ion` exists — nothing here decides it).
 *
 * Sign-in is entirely server-held now: the server runs the PKCE exchange
 * itself and answers `/auth/callback` directly with a 302 (setting the
 * `ion_session` cookie) before this bundle is ever loaded on that leg, so
 * there is no callback branch here to handle. The one thing this entry
 * point still decides for itself is the "no browser sign-in configured"
 * stop page (`/auth/config`'s `oidc === null` edge case) — `BrowserStudioHost`
 * itself only finds this out once it tries to connect, which is too late to
 * decide whether to render a shell at all.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { StudioShell } from './studio/StudioShell'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { rootErrorOptions } from './react-root-errors'
import { TypographySync } from './TypographySync'
import { WindowVisibilityGate } from './WindowVisibilityGate'
import { rWarn } from './rendererLogger'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Web renderer: #root container missing from web.html')
}

function renderNoSignIn(): void {
  createRoot(container!, rootErrorOptions('web')).render(
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', color: '#c9ccd6', background: '#14161c' }}>
      This server has no browser sign-in.
    </div>,
  )
}

function renderShell(): void {
  createRoot(container!, rootErrorOptions('web')).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <TypographySync />
        <WindowVisibilityGate />
        <StudioShell />
      </RootErrorBoundary>
    </React.StrictMode>,
  )
}

interface AuthConfigResponse {
  oidc: { issuer: string; audience: string; scope: string; clientId: string } | null
}

async function boot(): Promise<void> {
  try {
    const res = await fetch('/auth/config')
    if (res.ok) {
      const config = (await res.json()) as AuthConfigResponse
      if (!config.oidc) {
        renderNoSignIn()
        return
      }
    }
  } catch (err) {
    rWarn('web.main', 'failed to fetch /auth/config; rendering the shell anyway', { error: err instanceof Error ? err.message : String(err) })
  }
  renderShell()
}

void boot()
