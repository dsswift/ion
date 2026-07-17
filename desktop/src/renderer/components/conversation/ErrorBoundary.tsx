import React from 'react'
import { getColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { rError } from '../../rendererLogger'

interface Props {
  children: React.ReactNode
}

interface ErrorState {
  hasError: boolean
  error: Error | null
}

/**
 * Catches uncaught render errors inside conversation / engine views
 * so a single bad message doesn't kill the entire tab.
 *
 * Reload vs. retry: React error #185 ("Maximum update depth exceeded") is an
 * infinite setState loop — retrying re-renders the same loop and throws again
 * immediately. We detect this class of error and show a Reload button instead.
 * All other errors keep the Retry button so a transient bad-prop or missing-
 * data error can recover without a full page reload.
 */
function isLoopError(error: Error | null): boolean {
  if (!error) return false
  const msg = error.message.toLowerCase()
  return msg.includes('maximum update depth') || msg.includes('too many re-renders')
}

export class ConversationErrorBoundary extends React.Component<Props, ErrorState> {
  state: ErrorState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    rError('error-boundary', 'uncaught render error', { error: error.message, component_stack: info.componentStack })
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      const colors = getColors(usePreferencesStore.getState().isDark)
      const loop = isLoopError(this.state.error)
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            height: '100%',
            color: colors.textSecondary,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 11, color: colors.textTertiary, maxWidth: 280, textAlign: 'center' }}>
            {this.state.error?.message || 'An unexpected error occurred while rendering.'}
          </div>
          <button
            type="button"
            onClick={loop ? this.handleReload : this.handleReset}
            style={{
              marginTop: 4,
              padding: '6px 16px',
              borderRadius: 8,
              border: `1px solid ${colors.containerBorder}`,
              background: colors.surfaceHover,
              color: colors.textPrimary,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {loop ? 'Reload' : 'Retry'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
