#!/usr/bin/env node
/**
 * `quality.yml`'s `server-compose-smoke` job (manifest child 11): a plain
 * Node CLI script -- no test framework, since it drives the real
 * `docker compose` stack rather than an in-process fixture -- that:
 *
 *   1. Starts a local RS256 JWKS/OIDC-discovery fixture on
 *      `0.0.0.0:8089`, reachable from inside the `server` container as
 *      `http://host.docker.internal:8089` (see `docker-compose.yml`'s
 *      `extra_hosts`), matching `compose/server.json`'s `oidc.issuer`.
 *   2. Connects to the running compose stack's Studio wire
 *      (`ws://localhost:7331`) and confirms a `local`-credential hello over
 *      TCP is refused (manifest: local is socket-only).
 *   3. Signs a bearer token for `compose/server.json`'s configured
 *      issuer/audience/scope and confirms it is accepted.
 *   4. Confirms the accepted hello's `enterprisePolicy.allowedModels`
 *      matches `compose/enterprise.json` -- proving the policy travelled
 *      engine (`ION_ENTERPRISE_CONFIG`) -> `get_enterprise_policy` RPC ->
 *      `studio_welcome` end to end through the real compose stack.
 *
 * This is an operator-facing CLI tool, not shipped server code -- plain
 * `console.*` here is expected (the repo's `server/src/logger.ts` policy
 * governs the SERVER PROCESS, not this script).
 */
import { createServer } from 'http'
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose'
import WebSocket from 'ws'

const SERVER_URL = process.env.ION_SMOKE_SERVER_URL ?? 'ws://localhost:7331'
const JWKS_PORT = Number(process.env.ION_SMOKE_JWKS_PORT ?? 8089)
const ISSUER = process.env.ION_SMOKE_OIDC_ISSUER ?? 'http://host.docker.internal:8089'
const AUDIENCE = process.env.ION_SMOKE_OIDC_AUDIENCE ?? 'ion-studio-server-compose'
const SCOPE = process.env.ION_SMOKE_OIDC_SCOPE ?? 'ion.studio'
const EXPECTED_ALLOWED_MODELS = (process.env.ION_SMOKE_ALLOWED_MODELS ?? 'claude-sonnet-5,claude-opus-5').split(',')

let failures = 0

function ok(label) {
  console.log(`  ok   ${label}`)
}

function fail(label, detail) {
  failures += 1
  console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

/** RS256 JWKS + OIDC-discovery fixture -- mirrors `server/src/auth/__tests__/jwks-fixture.ts`, but bound to a fixed host:port a container can reach rather than an ephemeral localhost one, since this fixture must be reachable across the compose network. */
async function startJwksFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(jwk)
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  const server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(JWKS_PORT, '0.0.0.0', resolve)
  })
  console.log(`JWKS fixture listening on 0.0.0.0:${JWKS_PORT} (issuer ${ISSUER})`)
  return { privateKey, kid, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function signBearerToken(fixture, sub) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ scp: SCOPE })
    .setProtectedHeader({ alg: 'RS256', kid: fixture.kid })
    .setIssuedAt(now)
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(now + 300)
    .sign(fixture.privateKey)
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextFrame(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString('utf-8')))
    })
    ws.once('close', () => {
      clearTimeout(timer)
      reject(new Error('socket closed before a frame arrived'))
    })
  })
}

function helloFrame(credential, suffix) {
  return {
    type: 'studio_hello',
    protocolVersion: 1,
    clientId: `smoke-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
    clientKind: 'web',
    capabilities: [],
    credential,
  }
}

async function testLocalCredentialRefusedOverTcp() {
  const ws = await connect()
  try {
    ws.send(JSON.stringify(helloFrame({ kind: 'local' }, 'local')))
    const frame = await nextFrame(ws)
    if (frame.type === 'studio_refused') {
      ok('local credential over TCP is refused')
    } else {
      fail('local credential over TCP is refused', `got ${frame.type} instead of studio_refused`)
    }
  } finally {
    ws.close()
  }
}

async function testBearerCredentialAccepted(fixture) {
  const token = await signBearerToken(fixture, 'smoke-test-subject')
  const ws = await connect()
  try {
    ws.send(JSON.stringify(helloFrame({ kind: 'bearer', token }, 'bearer')))
    const frame = await nextFrame(ws)
    if (frame.type !== 'studio_welcome') {
      fail('fixture bearer token is accepted', `got ${frame.type}${frame.type === 'studio_refused' ? ` (reason ${frame.reason})` : ''}`)
      return
    }
    ok('fixture bearer token is accepted')

    const allowedModels = frame.enterprisePolicy?.allowedModels ?? []
    const matches = allowedModels.length === EXPECTED_ALLOWED_MODELS.length && EXPECTED_ALLOWED_MODELS.every((m) => allowedModels.includes(m))
    if (matches) {
      ok(`welcome.enterprisePolicy.allowedModels matches the mounted enterprise.json (${allowedModels.join(', ')})`)
    } else {
      fail('welcome.enterprisePolicy.allowedModels matches the mounted enterprise.json', `expected [${EXPECTED_ALLOWED_MODELS.join(', ')}], got [${allowedModels.join(', ')}]`)
    }
  } finally {
    ws.close()
  }
}

async function main() {
  console.log(`server-compose-smoke: target ${SERVER_URL}`)
  const fixture = await startJwksFixture()
  try {
    await testLocalCredentialRefusedOverTcp()
    await testBearerCredentialAccepted(fixture)
  } finally {
    await fixture.close()
  }

  if (failures > 0) {
    console.error(`server-compose-smoke: ${failures} check(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('server-compose-smoke: all checks passed')
}

main().catch((err) => {
  console.error('server-compose-smoke: unhandled error', err)
  process.exitCode = 1
})
