/**
 * EntraCategory.tsx — Entra OIDC sign-in settings (Feature 0001 Part F, F1-UI).
 *
 * Minimal sign-in affordance: shows the signed-in identity when present,
 * a "Sign in" button when not signed in, and a "Sign out" button when signed in.
 *
 * This is the desktop surface of feature 0001's OIDC telemetry auth — not a
 * full account-management UI. The sole purpose is to let the user authenticate
 * so the egress forwarder can attach a Bearer token to shipped log records.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useColors } from '../../theme'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import { rError } from '../../rendererLogger'

interface EntraIdentity {
  user: string
  username: string
  displayName: string
  oid: string
}

type SignInState = 'loading' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'

export function EntraCategory() {
  const colors = useColors()
  const [signInState, setSignInState] = useState<SignInState>('loading')
  const [identity, setIdentity] = useState<EntraIdentity | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Load current identity on mount.
  useEffect(() => {
    window.ion.entraIdentity()
      .then(({ identity: id }) => {
        setIdentity(id)
        setSignInState(id ? 'signed-in' : 'signed-out')
      })
      .catch(() => {
        setSignInState('signed-out')
      })
  }, [])

  const handleSignIn = useCallback(async () => {
    setSignInState('signing-in')
    setErrorMsg(null)
    try {
      const result = await window.ion.entraSignIn()
      if (result.ok && result.identity) {
        setIdentity(result.identity)
        setSignInState('signed-in')
      } else {
        setErrorMsg(result.error ?? 'Sign-in failed')
        setSignInState('error')
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sign-in failed')
      setSignInState('error')
    }
  }, [])

  const handleSignOut = useCallback(async () => {
    setSignInState('loading')
    try {
      await window.ion.entraSignOut()
    } catch {
      // Non-fatal — clear local state regardless.
    }
    setIdentity(null)
    setSignInState('signed-out')
  }, [])

  const buttonBase: React.CSSProperties = {
    padding: '7px 16px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    outline: 'none',
  }

  return (
    <>
      <SettingHeading first>Telemetry Authentication</SettingHeading>

      <SettingSection
        label="Microsoft Entra (OIDC)"
        description={
          'Sign in with your organizational account to attach user attribution to telemetry records. ' +
          'Access tokens are refreshed silently; re-authentication is only required when the session expires.'
        }
      >
        {signInState === 'loading' && (
          <p style={{ color: colors.textTertiary, fontSize: 13, margin: 0 }}>Loading…</p>
        )}

        {signInState === 'signed-in' && identity && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13,
              }}
            >
              <p style={{ margin: '0 0 2px', color: colors.textPrimary, fontWeight: 500 }}>
                {identity.displayName || identity.username || identity.user}
              </p>
              <p style={{ margin: 0, color: colors.textTertiary }}>
                {identity.username || identity.user}
              </p>
            </div>
            <div>
              <button
                onClick={() => { void handleSignOut().catch((err) => rError('settings', 'entra sign-out failed', { error: String(err) })) }}
                style={{
                  ...buttonBase,
                  background: colors.surfacePrimary,
                  color: colors.textSecondary,
                  border: `1px solid ${colors.containerBorder}`,
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        )}

        {(signInState === 'signed-out' || signInState === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {signInState === 'error' && errorMsg && (
              <p style={{ color: colors.statusError, fontSize: 12, margin: 0 }}>
                {errorMsg}
              </p>
            )}
            <div>
              <button
                onClick={() => { void handleSignIn().catch((err) => rError('settings', 'entra sign-in failed', { error: String(err) })) }}
                style={{
                  ...buttonBase,
                  background: colors.accent,
                  color: '#ffffff',
                }}
              >
                Sign in with Microsoft
              </button>
            </div>
          </div>
        )}

        {signInState === 'signing-in' && (
          <p style={{ color: colors.textTertiary, fontSize: 13, margin: 0 }}>
            A browser window has opened — complete sign-in there…
          </p>
        )}
      </SettingSection>
    </>
  )
}
