import React from 'react'
import { rError } from '../rendererLogger'

interface Props {
  children: React.ReactNode
}

interface ErrorState {
  hasError: boolean
  error: Error | null
}

/**
 * Root-level error boundary wrapping each renderer root (overlay and ATV).
 *
 * Catches render errors — including React #185 "Maximum update depth exceeded"
 * (infinite setState loops) — that escape inner boundaries. Shows a full-page
 * reload prompt instead of a retry button: re-rendering into an infinite loop
 * would throw again immediately, so only a page reload can recover.
 *
 * Error is logged via rError → desktop.jsonl so it shows up in the Loki stream
 * as a structured event (component=desktop, level=ERROR) instead of the
 * unattributed "Uncaught Error: Minified React error #185…" lines that appear
 * when nothing catches the throw.
 *
 * Colors are intentionally literal (not theme tokens): this fallback must
 * render even when the theme/preferences subsystem is the thing that crashed,
 * so it takes no dependency on the color system.
 */
export class RootErrorBoundary extends React.Component<Props, ErrorState> {
  state: ErrorState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    rError('root-error-boundary', 'uncaught root render error', {
      error: error.message,
      component_stack: info.componentStack ?? '',
    })
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            gap: 16,
            padding: 32,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: 'rgba(255,255,255,0.7)', // hardcoded-ok: root fallback must render without the (possibly crashed) theme system
            background: '#111', // hardcoded-ok: root fallback must render without the (possibly crashed) theme system
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 15, color: 'rgba(255,255,255,0.9)' /* hardcoded-ok: theme-independent root fallback */ }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', maxWidth: 320, textAlign: 'center', lineHeight: 1.5 /* hardcoded-ok: theme-independent root fallback */ }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </div>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              marginTop: 4,
              padding: '7px 18px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.15)', // hardcoded-ok: theme-independent root fallback
              background: 'rgba(255,255,255,0.08)', // hardcoded-ok: theme-independent root fallback
              color: 'rgba(255,255,255,0.8)', // hardcoded-ok: theme-independent root fallback
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
