import { describe, it, expect } from 'vitest'

import {
  classifyCredentialError,
  classifyCloseCode,
  CLOSE_CODE_TOKEN_EXPIRED,
  CLOSE_CODE_FORBIDDEN,
  CLOSE_CODE_NO_CHANNEL,
} from '../relay-failure'

describe('classifyCredentialError', () => {
  // The observed production case: an unsigned-in user produced a
  // credential-fetch failure every ~14 seconds, indefinitely, because every
  // failure fed the same backoff. Retrying cannot mint a grant that does not
  // exist.
  it.each([
    ['oidc_token: no token returned', 'sign_in_required'],
    ['has key: no credentials found', 'sign_in_required'],
    ['no refresh token available', 'sign_in_required'],
    ['invalid_grant: refresh_token_already_used', 'sign_in_required'],
    ['AADSTS65001: user has not consented', 'consent_required'],
    ['access_denied by tenant policy', 'consent_required'],
    ['invalid_scope: the requested scope is not configured', 'scope_misconfigured'],
  ])('classifies %j as permanent (%s)', (msg, reason) => {
    const got = classifyCredentialError(new Error(msg))
    expect(got.class).toBe('permanent')
    expect(got.reason).toBe(reason)
  })

  it.each([
    'connect ETIMEDOUT 10.0.0.1:443',
    'getaddrinfo ENOTFOUND login.example.com',
    'connect ECONNREFUSED 127.0.0.1:8080',
    'socket hang up',
    'token endpoint returned 503',
  ])('classifies %j as transient', (msg) => {
    expect(classifyCredentialError(new Error(msg)).class).toBe('transient')
  })

  // Misclassifying a transient failure as permanent would strand a connection
  // that would have healed on its own, so anything unrecognised keeps retrying.
  it('treats an unrecognised message as unknown, not permanent', () => {
    const got = classifyCredentialError(new Error('something nobody has seen before'))
    expect(got.class).toBe('unknown')
    expect(got.detail).toBe('something nobody has seen before')
  })

  it('tolerates an error with no message', () => {
    expect(classifyCredentialError(new Error()).class).toBe('unknown')
  })
})

describe('classifyCloseCode', () => {
  // 4401 is the one auth-band code that IS transient: the token expired and
  // the next connect mints a fresh one, so the retry is the remedy.
  it('treats token-expired as transient because the retry is the fix', () => {
    const got = classifyCloseCode(CLOSE_CODE_TOKEN_EXPIRED, '')
    expect(got.class).toBe('transient')
    expect(got.reason).toBe('token_expired')
  })

  it('treats forbidden and missing-channel as permanent', () => {
    expect(classifyCloseCode(CLOSE_CODE_FORBIDDEN, 'nope').class).toBe('permanent')
    expect(classifyCloseCode(CLOSE_CODE_NO_CHANNEL, 'gone').class).toBe('permanent')
  })

  it.each([1006, 1012, 1013, 1001])('treats %d as transient', (code) => {
    expect(classifyCloseCode(code, '').class).toBe('transient')
  })

  it('treats an unrecognised auth-band code as permanent', () => {
    expect(classifyCloseCode(4450, 'policy').class).toBe('permanent')
  })

  it('treats an unrecognised non-auth code as unknown so it keeps retrying', () => {
    expect(classifyCloseCode(3000, '').class).toBe('unknown')
  })

  it('carries the close reason through as detail', () => {
    expect(classifyCloseCode(CLOSE_CODE_FORBIDDEN, 'device not paired').detail)
      .toBe('device not paired')
  })
})
