import type { TokenResult } from './token-refresh'

/**
 * Shares one OIDC credential stream across every paired relay client.
 *
 * A relay HTTP 401 can mean the issuer revoked a token before its advertised
 * expiry. The next credential request must bypass the engine cache once, but
 * three reconnecting devices must share that one refresh-token transaction.
 */
export class RelayCredentialSource {
  private forceRefreshRequested = false
  private forcedRequest: Promise<TokenResult> | null = null

  constructor(
    private readonly oidcScope: string,
    private readonly requestToken: (oidcScope: string, forceRefresh: boolean) => Promise<TokenResult>,
    private readonly onToken: (expiresAt: number | undefined) => void,
    private readonly warn: (msg: string, fields?: Record<string, unknown>) => void,
  ) {}

  requestForcedRefresh(): void {
    this.forceRefreshRequested = true
  }

  async getCredential(): Promise<string> {
    const result = await this.getTokenResult()
    if (!result.ok || !result.data?.accessToken) {
      throw new Error(result.error ?? 'oidc_token: no token returned')
    }
    this.onToken(result.data.expiresAt)
    return result.data.accessToken
  }

  private async getTokenResult(): Promise<TokenResult> {
    if (!this.forceRefreshRequested) {
      return this.requestToken(this.oidcScope, false)
    }

    if (this.forcedRequest === null) {
      this.forcedRequest = this.requestToken(this.oidcScope, true)
        .then((result) => {
          if (result.ok && result.data?.accessToken) {
            this.forceRefreshRequested = false
          }
          return result
        })
        .finally(() => {
          this.forcedRequest = null
        })
    }
    return this.forcedRequest
  }
}
