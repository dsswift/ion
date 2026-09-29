/**
 * EntraSection — Microsoft Entra (OIDC) sign-in on the picked server. It lets
 * the person authenticate so the egress forwarder can attach a Bearer token,
 * and so user attribution, to shipped telemetry records. Not account
 * management: one row, its state, and Sign in or Sign out.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { SignIn, SignOut } from '@phosphor-icons/react'
import { useSettingsShell } from '../../settings-shell'
import { Button, FormGroup, FormRow } from '../../kit'
import { rError, rInfo, rWarn } from '../../../../rendererLogger'

interface EntraIdentity {
  user: string
  username: string
  displayName: string
  oid: string
}

type SignInState = 'loading' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'

export function EntraSection(): React.JSX.Element {
  // The picked server's enterprise sign-in, not this machine's.
  const { shell, environmentId } = useSettingsShell()
  const [signInState, setSignInState] = useState<SignInState>('loading')
  const [identity, setIdentity] = useState<EntraIdentity | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    shell.entraIdentity()
      .then(({ identity: id }) => {
        setIdentity(id)
        setSignInState(id ? 'signed-in' : 'signed-out')
      })
      .catch((err: unknown) => {
        rWarn('settings', 'entra identity read failed', { environment_id: environmentId, error: String(err) })
        setSignInState('signed-out')
      })
  }, [shell, environmentId])

  const handleSignIn = useCallback(async () => {
    setSignInState('signing-in')
    setErrorMsg(null)
    try {
      const result = await shell.entraSignIn()
      if (result.ok && result.identity) {
        rInfo('settings', 'entra signed in', { environment_id: environmentId })
        setIdentity(result.identity)
        setSignInState('signed-in')
      } else {
        rWarn('settings', 'entra sign-in refused', { environment_id: environmentId, error: result.error ?? '' })
        setErrorMsg(result.error ?? 'Sign-in failed')
        setSignInState('error')
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sign-in failed')
      setSignInState('error')
    }
  }, [shell, environmentId])

  const handleSignOut = useCallback(async () => {
    setSignInState('loading')
    try {
      await shell.entraSignOut()
    } catch (err) {
      // Non-fatal: the local state is cleared regardless.
      rWarn('settings', 'entra sign-out call failed; clearing local state', { environment_id: environmentId, error: String(err) })
    }
    setIdentity(null)
    setSignInState('signed-out')
  }, [shell, environmentId])

  const name = identity ? identity.displayName || identity.username || identity.user : ''
  const account = identity ? identity.username || identity.user : ''
  const description = signInState === 'loading' ? 'Loading…'
    : signInState === 'signing-in' ? 'A browser window has opened — complete sign-in there…'
      : signInState === 'signed-in' && identity ? `Signed in as ${name}${account && account !== name ? ` (${account})` : ''}`
        : 'Sign in with your organization account to attach user attribution to telemetry records. Tokens refresh silently.'
  const signedIn = signInState === 'signed-in' && identity !== null

  return (
    <FormGroup title="Enterprise sign-in" anchor="entra">
      <FormRow label="Microsoft Entra (OIDC)" description={description} warning={signInState === 'error' ? errorMsg ?? undefined : undefined}>
        {signedIn && (
          <Button icon={SignOut} onClick={() => { void handleSignOut().catch((err: unknown) => rError('settings', 'entra sign-out failed', { error: String(err) })) }}>Sign out</Button>
        )}
        {(signInState === 'signed-out' || signInState === 'error') && (
          <Button variant="primary" icon={SignIn} onClick={() => { void handleSignIn().catch((err: unknown) => rError('settings', 'entra sign-in failed', { error: String(err) })) }}>Sign in with Microsoft</Button>
        )}
      </FormRow>
    </FormGroup>
  )
}
