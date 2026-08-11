import React from 'react'
import { CheckCircle, CircleNotch, SignIn } from '@phosphor-icons/react'
import { useColors } from '../../theme'

// ---------------------------------------------------------------------------
// OIDC auth sub-panel (extracted to keep RemoteCategoryRelay under 600 lines)
// ---------------------------------------------------------------------------

interface OidcAuthPanelProps {
  signedInUser: string | null
  isSigningIn: boolean
  onSignIn: () => void
  colors: ReturnType<typeof useColors>
}

export function OidcAuthPanel({ signedInUser, isSigningIn, onSignIn, colors }: OidcAuthPanelProps) {
  const smallBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 12px',
    borderRadius: 8,
    fontSize: 12,
    cursor: 'pointer',
    border: 'none',
  }

  if (signedInUser) {
    return (
      <div style={{
        marginBottom: 12,
        padding: '8px 12px',
        background: `${colors.statusComplete}15`,
        border: `1px solid ${colors.statusComplete}40`,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <CheckCircle size={16} color={colors.statusComplete} />
        <div>
          <div style={{ color: colors.textPrimary, fontSize: 12, fontWeight: 500 }}>
            Signed in as {signedInUser}
          </div>
          <div style={{ color: colors.textTertiary, fontSize: 11 }}>
            Enterprise relay auth ready
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        padding: '8px 12px',
        background: `${colors.accent}10`,
        border: `1px solid ${colors.accent}30`,
        borderRadius: 8,
        marginBottom: 8,
      }}>
        <div style={{ color: colors.textPrimary, fontSize: 12, fontWeight: 500, marginBottom: 2 }}>
          Enterprise sign-in required
        </div>
        <div style={{ color: colors.textTertiary, fontSize: 11 }}>
          This relay uses Microsoft Entra identity. Sign in to connect.
        </div>
      </div>
      <button
        onClick={onSignIn}
        disabled={isSigningIn}
        style={{
          ...smallBtnStyle,
          background: colors.accent,
          color: colors.textOnAccent,
          opacity: isSigningIn ? 0.7 : 1,
        }}
      >
        {isSigningIn ? (
          <CircleNotch size={14} style={{ animation: 'spin 1s linear infinite' }} />
        ) : (
          <SignIn size={14} />
        )}
        {isSigningIn ? 'Signing in...' : 'Sign in with Microsoft'}
      </button>
    </div>
  )
}
