import React from 'react'
import { getColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'

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
 */
export class ConversationErrorBoundary extends React.Component<Props, ErrorState> {
  state: ErrorState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ConversationErrorBoundary]', error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const colors = getColors(usePreferencesStore.getState().isDark)
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
            onClick={this.handleReset}
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
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
