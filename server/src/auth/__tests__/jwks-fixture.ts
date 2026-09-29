/**
 * A real local HTTP server serving one RS256 JWKS, plus a token signer, for
 * `bearer.test.ts` and `relay-roundtrip.test.ts`. `bearer.ts` uses `jose`'s
 * `createRemoteJWKSet`, which performs a real HTTP fetch -- this fixture
 * exists so that fetch has something real to hit rather than mocking `fetch`
 * itself (mocking would leave `createRemoteJWKSet`'s own HTTP/caching logic
 * unexercised).
 */
import { createServer, type Server } from 'http'
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose'

export interface JwksFixture {
  issuer: string
  kid: string
  privateKey: CryptoKey
  close(): Promise<void>
}

export async function startJwksFixture(): Promise<JwksFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(jwk)
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  let issuer = ''
  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      const body = JSON.stringify({ keys: [jwk] })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    // Standard OIDC discovery document -- both `bearer.ts`'s own discovery
    // (which falls back to the conventional jwks.json path on failure) and
    // the relay's `oidc.go` (which does NOT fall back; a real relay's own
    // JWKS init hard-fails without this) fetch this first.
    if (req.url === '/.well-known/openid-configuration') {
      const body = JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  issuer = `http://127.0.0.1:${port}`

  return {
    issuer,
    kid,
    privateKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface SignTokenClaims {
  sub: string
  aud: string
  /** Overrides the fixture's own issuer -- used to produce a `wrong_issuer` case. */
  iss?: string
  scp?: string
  roles?: string[]
  /** Seconds from now (may be negative to mint an already-expired token). Defaults to 3600. */
  expiresInSeconds?: number
  name?: string
  preferred_username?: string
}

export async function signToken(fixture: JwksFixture, claims: SignTokenClaims): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const exp = nowSeconds + (claims.expiresInSeconds ?? 3600)
  const jwt = new SignJWT({
    scp: claims.scp,
    roles: claims.roles,
    name: claims.name,
    preferred_username: claims.preferred_username,
  })
    .setProtectedHeader({ alg: 'RS256', kid: fixture.kid })
    .setIssuedAt()
    .setSubject(claims.sub)
    .setIssuer(claims.iss ?? fixture.issuer)
    .setAudience(claims.aud)
    .setExpirationTime(exp)
  return jwt.sign(fixture.privateKey)
}
