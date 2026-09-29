import { randomBytes, createHash } from 'crypto'

function base64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** Generate PKCE code verifier and challenge for OAuth flows. */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64urlEncode(randomBytes(32))
  const challenge = base64urlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Generate random state parameter for OAuth flows. */
export function generateState(): string {
  return randomBytes(16).toString('hex')
}
