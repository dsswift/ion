/**
 * environment-connect — builds a `ConnectionTarget` (broker.ts) from a
 * persisted `EnvironmentTarget` (spec 13, manifest C10) and drives the
 * broker's connect/disconnect/restart for it. This is the main-process
 * counterpart to the renderer's registry: the renderer decides WHEN to
 * attempt a connection, this module decides HOW (which transport, which
 * stored credential).
 *
 * The local environment is connected automatically at boot (index.ts) once
 * the local server reports it is listening; this module handles only the
 * non-local (`paired`/`bearer`) targets the renderer's registry requests.
 *
 * Every part of reaching a server -- opening the ssh forward, choosing
 * between LAN and relay, fetching the nonce, deriving the proof -- happens
 * inside the broker's per-attempt `open()`, never once up front. A server
 * that is down when the desktop launches therefore produces a connection
 * that is retrying, not an error the renderer has to remember to retry
 * itself: the moment that server comes back, the next attempt succeeds and
 * its conversations reappear on their own.
 *
 * A paired target that stored relays at pairing time is dialed over the
 * LAN when its address answers and over a relay when it does not
 * (`resolveRoute`); while on the relay the LAN address is probed again on
 * a timer and the connection is restarted onto it as soon as it answers,
 * so leaving and returning to the office never needs a click.
 *
 * "Its address" is not one address. Every welcome reports where the server
 * answers directly, including its `.local` name, and those are stored beside
 * the secret (`rememberDirectAddresses`). A route probes the saved address
 * and every reported one together (`direct-route.ts`), so a laptop that
 * moved to another network is found again on that network with no relay.
 */
import { randomUUID } from 'crypto'
import { dataDir } from '@ion/server/paths'
import type { EnvironmentTarget, PairedEnvironmentTarget } from '@ion/shared/types-environments'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { StudioCredential } from '@ion/shared/studio-wire/types'
import { connectLocal } from './transport-local'
import { connectTcp, connectSealedTcp, serverSealsTcp, fetchAuthConfig, buildPairedCredential, buildBearerCredential, requireNonce } from './transport-tcp'
import { connectRelayStudio, type StudioSocketLike } from './transport-relay'
import { isEnvironmentRelay, type EnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import { sshTunnels } from './ssh/ssh-tunnel-instance'
import { loadCredential, saveCredential } from './credentials'
import { decodePairedSecret, encodePairedSecret, sanitizeDirectAddresses, type PairedSecret } from './paired-secret'
import { findDirectUrl } from './direct-route'
import { requestOidcToken } from './token-source'
import { bearerTokenFor } from './server-bearer'
import { ownRelayIdentity } from './own-identity'
import { relayIssuerFor } from './relay-issuer'
import { composeOidcScope } from '@ion/shared/relay-auth-config'
import { broker } from './broker-instance'
import { DESKTOP_CLIENT_CAPABILITIES } from './client-capabilities'
import type { ConnectionAttempt } from './broker'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('environment-connect', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('environment-connect', msg, fields)
}

const CLIENT_ID = `desktop-${randomUUID()}`

/** The target each connected environment was connected with, so a welcome can be filed against the right stored secret. */
const connectedTargets = new Map<string, EnvironmentTarget>()
let welcomeListenerInstalled = false

/** Files the relays and direct addresses each welcome reports. Installed with the first non-local connect. */
function installWelcomeListener(): void {
  if (welcomeListenerInstalled) return
  welcomeListenerInstalled = true
  broker.onFrame((environmentId, frame) => {
    if (frame.type !== 'studio_welcome') return
    const target = connectedTargets.get(environmentId)
    if (!target) return
    if (frame.relays !== undefined) rememberAdvertisedRelays(environmentId, target, frame.relays)
    if (frame.directAddresses !== undefined) rememberDirectAddresses(environmentId, target, frame.directAddresses)
  })
}

/**
 * The stored paired secret for `environmentId`, or a thrown, logged error.
 * The record carries the server-registered clientId alongside the secret
 * (`paired-secret.ts`); a store entry that is not that shape is treated as
 * missing rather than guessed at.
 */
function requirePairedSecret(environmentId: string): PairedSecret {
  const stored = loadCredential(environmentId)
  if (!stored || stored.kind !== 'paired') throw new Error(`no paired secret stored for environment ${environmentId}`)
  const secret = decodePairedSecret(stored.plaintext)
  if (!secret) {
    warn('stored paired credential is not a v1 paired-secret record; re-pair this environment', { environment_id: environmentId })
    throw new Error(`stored paired credential for environment ${environmentId} is unreadable; re-pair`)
  }
  return secret
}

/** The stored paired secret, or null when there is none or it is unreadable. */
function loadPairedSecretOrNull(key: string): PairedSecret | null {
  const stored = loadCredential(key)
  return stored && stored.kind === 'paired' ? decodePairedSecret(stored.plaintext) : null
}

/**
 * Keeps what a server says about its relays. A pair response says it once;
 * every welcome says it again, so a relay the server gained after pairing is
 * learned on the next connect instead of needing a new pairing. Returns
 * whether the stored record changed.
 */
export function rememberAdvertisedRelays(environmentId: string, target: EnvironmentTarget, relays: unknown): boolean {
  if (target.kind !== 'paired' || !Array.isArray(relays)) return false
  const key = credentialKey(environmentId, target)
  const secret = loadPairedSecretOrNull(key)
  if (!secret) return false
  const next = relays.filter(isEnvironmentRelay)
  if (JSON.stringify(next) === JSON.stringify(secret.relays ?? [])) return false
  saveCredential(key, 'paired', encodePairedSecret({ ...secret, relays: next }))
  log('relays reported by the server were stored', { environment_id: environmentId, relay_count: next.length, relay_urls: next.map((r) => r.url) })
  return true
}

/**
 * Keeps where a server says it answers directly. Every welcome says it, so
 * the list is as fresh as the last connect: the addresses of the network the
 * server was on then, and its `.local` name, which is right on any network.
 * Returns whether the stored record changed.
 */
export function rememberDirectAddresses(environmentId: string, target: EnvironmentTarget, addresses: unknown): boolean {
  if (target.kind !== 'paired' || !Array.isArray(addresses)) return false
  const key = credentialKey(environmentId, target)
  const secret = loadPairedSecretOrNull(key)
  if (!secret) return false
  const next = sanitizeDirectAddresses(addresses)
  if (JSON.stringify(next) === JSON.stringify(secret.directAddresses ?? [])) return false
  saveCredential(key, 'paired', encodePairedSecret({ ...secret, directAddresses: next }))
  log('direct addresses reported by the server were stored', { environment_id: environmentId, addresses: next.join(','), dropped: addresses.length - next.length })
  return true
}

/**
 * Where a paired target's secret is stored: its `credentialRef`. That is
 * the server's environment id when the pairing learned it (LAN, SSH) and
 * the registered clientId when it did not yet (a pairing completed through
 * a relay, whose environment id arrives with the first welcome), while the
 * catalog's own entry id may still be an index placeholder at that point.
 */
function credentialKey(environmentId: string, target: EnvironmentTarget): string {
  return target.kind === 'paired' && target.credentialRef ? target.credentialRef : environmentId
}

/**
 * The HTTP base to dial for a paired target: its `url`, except over SSH,
 * where the server sits at the local end of the forward this desktop opens.
 */
function dialUrl(target: EnvironmentTarget, localPort: number | null): string {
  if (target.kind === 'paired' && target.via === 'ssh') {
    if (localPort === null) throw new Error(`ssh forward for ${target.ssh?.destination ?? target.url} is not open`)
    return `http://127.0.0.1:${localPort}`
  }
  if (target.kind === 'local') throw new Error('the local environment has no dial url')
  return target.url
}

/** Builds the `studio_hello` credential for a target from its stored secret/token. */
async function resolveCredential(environmentId: string, target: EnvironmentTarget, localPort: number | null, route: Route): Promise<StudioCredential> {
  if (target.kind === 'local') return { kind: 'local' }
  if (target.kind === 'paired') {
    // The hello's clientId MUST be the one the server registered at pairing
    // time: `auth/paired.ts` looks the credential record up by it before
    // checking the proof, so any other id (this process's own CLIENT_ID,
    // say) is refused `unauthorized` no matter how valid the proof is.
    const secret = requirePairedSecret(credentialKey(environmentId, target))
    if (route.kind === 'relay') {
      // No HTTP nonce exists over a relay. The E2E channel keyed by the
      // shared secret is the proof (`server/src/protocol/relay-listener.ts`
      // pre-verifies the clientId); the proof field carries an HMAC over a
      // fixed tag so the credential keeps its wire shape.
      return buildPairedCredential(secret.clientId, RELAY_PROOF_TAG, secret.sharedSecret)
    }
    const config = await fetchAuthConfig(route.url ?? dialUrl(target, localPort))
    const nonce = requireNonce(config)
    // Learned here, used by `connectFnFor` on the next socket it opens: the
    // config is read before every hello, the socket before every config.
    const seals = serverSealsTcp(config)
    if (sealedTcpByEnvironment.get(environmentId) !== seals) log('server sealed-tcp support', { environment_id: environmentId, sealed_tcp: seals })
    sealedTcpByEnvironment.set(environmentId, seals)
    return buildPairedCredential(secret.clientId, nonce, secret.sharedSecret)
  }
  // bearer: a token from the server's own sign-in app, never this machine's
  // identity. The person must be the subject the server's browser sign-in
  // and the phone produce, and the server may sit in another tenant.
  if (!target.oidc) throw new Error(`bearer environment ${environmentId} has no sign-in configuration`)
  return buildBearerCredential(await bearerTokenFor(environmentId, target.oidc))
}

/**
 * Whether each paired environment's server opens sealed frames on TCP, as its
 * last `/auth/config` said. A server that predates sealed TCP would close the
 * socket over an envelope it cannot parse, so a paired connection seals only
 * once the server has said it can open them.
 */
const sealedTcpByEnvironment = new Map<string, boolean>()

/** A paired target's TCP socket: sealed when the server supports it, plain otherwise. */
function pairedTcpSocket(environmentId: string, target: PairedEnvironmentTarget, url: string): StudioSocketLike {
  if (!sealedTcpByEnvironment.get(environmentId)) {
    warn('paired tcp connection is NOT sealed: the server does not advertise sealed frames', { environment_id: environmentId })
    return connectTcp(url)
  }
  const secret = requirePairedSecret(credentialKey(environmentId, target))
  return connectSealedTcp(url, secret.clientId, secret.sharedSecret)
}

/** Resolves the raw WebSocket factory for a target (local socket, TCP, ssh forward, or relay channel). */
function connectFnFor(environmentId: string, target: EnvironmentTarget, localPort: number | null, route: Route): () => StudioSocketLike {
  if (target.kind === 'local') {
    return () => connectLocal(dataDir())
  }
  // The route decides first, including for an ssh target: `resolveRoute`
  // falls one back to its reported relay when the forward could not open,
  // and dialing the forward's local end anyway would only throw over a port
  // that is not there.
  if (route.kind === 'relay') {
    const secret = requirePairedSecret(credentialKey(environmentId, target))
    const relay = route.relay
    const bearer = route.bearer
    return () => connectRelayStudio(relay, secret.sharedSecret, bearer)
  }
  if (target.kind === 'paired' && target.via === 'ssh') {
    // Re-read the port on every attempt: the forward keeps its port across
    // restarts, but a stopped-and-reopened environment may reserve a new one.
    // Sealed over the forward too: the server cannot tell an ssh-forwarded
    // client from any other TCP client, and one rule is simpler to hold than
    // an exemption keyed on a loopback address.
    return () => pairedTcpSocket(environmentId, target, dialUrl(target, sshTunnels.localPortOf(environmentId) ?? localPort))
  }
  if (target.kind === 'paired') {
    const url = route.url ?? target.url
    return () => pairedTcpSocket(environmentId, target, url)
  }
  return () => connectTcp(target.url)
}

/**
 * How a paired target is reached this time. `tcp` when one of the server's
 * direct addresses answers `/auth/config` as this server, with `url` naming
 * which (absent: dial the target's own address, as when there is nothing to
 * choose between, so a refusal is reported rather than hidden); `relay` when
 * none answers and the pairing stored a relay.
 */
type Route = { kind: 'tcp'; url?: string } | { kind: 'relay'; relay: EnvironmentRelay; bearer: string }

/** Placeholder nonce for the relay proof; the channel secret is the real proof. */
const RELAY_PROOF_TAG = 'relay'
/** How often a relay-connected environment re-probes its LAN address. */
export const LAN_REPROBE_INTERVAL_MS = 60_000

/** The direct addresses the server reported at its last welcome. */
function learnedAddresses(environmentId: string, target: PairedEnvironmentTarget): string[] {
  return loadPairedSecretOrNull(credentialKey(environmentId, target))?.directAddresses ?? []
}

/**
 * The bearer a relay join presents: the advertised PSK, or an OIDC token
 * minted by the local server. A relay that authenticates with its own
 * issuers is asked which it accepts; the token is for the one this operator
 * is signed in to.
 */
async function relayBearer(relay: EnvironmentRelay): Promise<string> {
  if (relay.auth.mode === 'psk') return relay.auth.key
  if (relay.auth.mode === 'relay-oidc') {
    const identity = await ownRelayIdentity(broker, LOCAL_ENVIRONMENT_ID)
    if (!identity) throw new Error(`relay ${relay.url} needs a signed-in identity; sign in under Settings, then reconnect`)
    // The relay binds the channel to the server's account, and the server
    // announces on it the identity this desktop gave when it paired, so the
    // relay admits this desktop from another tenant than the server's. The
    // relay decides: a join never claims a channel, and one it does not
    // admit is refused there (`transport-relay.ts` reports why).
    const serverIssuer = relay.auth.issuer
    if (serverIssuer && !sameIssuer(serverIssuer, identity.issuer)) {
      log('relay join from a different tenant than the server; admission rests on the identity the server announces', { relay_url: relay.url, server_issuer: serverIssuer, own_issuer: identity.issuer })
    }
    const entry = await relayIssuerFor(relay.url, identity.issuer)
    const minted = await requestOidcToken(broker, LOCAL_ENVIRONMENT_ID, { scope: composeOidcScope(entry.audience, entry.requiredScope) })
    return minted.accessToken
  }
  const result = await requestOidcToken(broker, LOCAL_ENVIRONMENT_ID, { scope: relay.auth.scope, audience: relay.auth.audience })
  return result.accessToken
}

/**
 * Whether two issuer URLs name one tenant. A trailing slash is ignored: an
 * id_token and a relay's config may spell the same issuer either way.
 */
function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '')
}

async function resolveRoute(environmentId: string, target: PairedEnvironmentTarget, localPort: number | null): Promise<Route> {
  if (target.via === 'ssh') {
    // `localPort` is null only when the forward could not be opened (the
    // host is out of SSH's reach, as from another network). A relay the
    // host reported is then the way in; with none, the SSH failure stands.
    if (localPort !== null) return { kind: 'tcp' }
    const sshSecret = loadPairedSecretOrNull(credentialKey(environmentId, target))
    const sshRelay = sshSecret?.relays?.[0]
    if (!sshRelay) throw new Error(`ssh to ${target.ssh?.destination ?? target.url} failed and this environment has reported no relay to fall back to`)
    log('route resolved: ssh forward unavailable; falling back to relay', { environment_id: environmentId, relay_url: sshRelay.url })
    return { kind: 'relay', relay: sshRelay, bearer: await relayBearer(sshRelay) }
  }
  const stored = loadCredential(credentialKey(environmentId, target))
  const secret = stored && stored.kind === 'paired' ? decodePairedSecret(stored.plaintext) : null
  const relays = secret?.relays ?? []
  const learned = secret?.directAddresses ?? []
  if (target.via === 'lan') {
    // Nothing to choose between: dial the saved address and let a refusal show.
    if (relays.length === 0 && learned.length === 0) return { kind: 'tcp' }
    const found = await findDirectUrl(environmentId, target.url, learned)
    if (found) {
      log(found === target.url ? 'route resolved: LAN answers; dialing tcp' : 'route resolved: saved address silent; server answers at an address it reported; dialing tcp', { environment_id: environmentId, url: found, saved_url: target.url })
      return { kind: 'tcp', url: found }
    }
    if (relays.length === 0) {
      log('route resolved: no direct address answers and no relay stored; dialing the saved address', { environment_id: environmentId, url: target.url, learned: learned.length })
      return { kind: 'tcp' }
    }
    log('route resolved: LAN silent; falling back to relay', { environment_id: environmentId, url: target.url, learned: learned.length, relay_url: relays[0].url })
    return { kind: 'relay', relay: relays[0], bearer: await relayBearer(relays[0]) }
  }
  // via 'relay': paired through a relay. Try the LAN address the link named,
  // and any the server has reported since, else the stored relay.
  const found = await findDirectUrl(environmentId, target.url, learned)
  if (found) {
    log('route resolved: relay-paired environment answers on LAN; dialing tcp', { environment_id: environmentId, url: found })
    return { kind: 'tcp', url: found }
  }
  const relay = relays[0] ?? (target.relayUrls?.[0] ? { url: target.relayUrls[0], auth: { mode: 'psk' as const, key: '' } } : null)
  if (!relay) throw new Error(`relay environment ${environmentId} has no relay recorded; re-pair`)
  return { kind: 'relay', relay, bearer: await relayBearer(relay) }
}

const lanReprobeTimers = new Map<string, ReturnType<typeof setInterval>>()

/** Whether the target's own route (its LAN address, or its SSH forward) works again. */
async function directRouteAnswers(environmentId: string, target: PairedEnvironmentTarget): Promise<boolean> {
  if (target.via !== 'ssh' || !target.ssh) return (await findDirectUrl(environmentId, target.url, learnedAddresses(environmentId, target))) !== null
  try {
    await sshTunnels.ensure(environmentId, target.ssh)
    return true
  } catch {
    // silent-ok: still out of SSH's reach is the state this probe polls for; the reconnect logs the change
    sshTunnels.stop(environmentId)
    return false
  }
}

/** While on the relay, keeps checking the LAN address; the first answer restarts the connection onto tcp. */
function armLanReprobe(environmentId: string, label: string, target: PairedEnvironmentTarget): void {
  disarmLanReprobe(environmentId)
  const timer = setInterval(() => {
    void directRouteAnswers(environmentId, target).then((answers) => {
      if (!answers) return
      log('direct route answers again; restarting onto tcp', { environment_id: environmentId, url: target.url, via: target.via })
      disarmLanReprobe(environmentId)
      broker.disconnect(environmentId)
      void connectEnvironment(environmentId, label, target).catch((err) => warn('return-to-LAN reconnect failed', { environment_id: environmentId, error: String(err) }))
    })
  }, LAN_REPROBE_INTERVAL_MS)
  timer.unref?.()
  lanReprobeTimers.set(environmentId, timer)
}

function disarmLanReprobe(environmentId: string): void {
  const timer = lanReprobeTimers.get(environmentId)
  if (!timer) return
  clearInterval(timer)
  lanReprobeTimers.delete(environmentId)
}

/** TEST ONLY: whether a return-to-LAN probe is armed for an environment. */
export function _lanReprobeArmedForTest(environmentId: string): boolean {
  return lanReprobeTimers.has(environmentId)
}

/**
 * Connects one non-local environment: resolves its credential, builds the
 * transport factory, and hands both to the broker. Throws (logged, never
 * silently swallowed) when the credential cannot be resolved — the caller
 * (the IPC handler) reports the failure back to the renderer's registry so
 * it can classify the phase.
 */
/**
 * One attempt at a non-local environment: opens the ssh forward if it has
 * one, resolves the route and the credential, and opens the socket. Handed
 * to the broker, which runs it again for every retry — so a throw here is a
 * failed attempt, not a failed connection.
 */
async function openNonLocal(environmentId: string, label: string, target: EnvironmentTarget): Promise<ConnectionAttempt> {
  let localPort: number | null = null
  if (target.kind === 'paired' && target.via === 'ssh') {
    if (!target.ssh) throw new Error(`ssh environment ${environmentId} has no ssh leg recorded; remove and add it again`)
    log('attempt: opening ssh forward', { environment_id: environmentId, destination: target.ssh.destination, remote_port: target.ssh.remotePort })
    try {
      localPort = (await sshTunnels.ensure(environmentId, target.ssh)).localPort
    } catch (err) {
      // Left null: resolveRoute falls back to a reported relay, or rethrows
      // this as the reason when there is none.
      warn('attempt: ssh forward could not open', { environment_id: environmentId, destination: target.ssh.destination, error: (err as Error).message })
      sshTunnels.stop(environmentId)
    }
  }
  const route: Route = target.kind === 'paired' ? await resolveRoute(environmentId, target, localPort) : { kind: 'tcp' }
  const credential = await resolveCredential(environmentId, target, localPort, route)
  if (route.kind === 'relay' && target.kind === 'paired') armLanReprobe(environmentId, label, target)
  else disarmLanReprobe(environmentId)
  const socket = connectFnFor(environmentId, target, localPort, route)()
  log('attempt: socket opened', { environment_id: environmentId, transport: route.kind })
  return { transport: route.kind, credential, socket }
}

/**
 * Hands one environment to the broker. Non-local targets resolve nothing
 * here: the broker owns the attempt (see `openNonLocal`), so this call
 * cannot fail over a server that happens to be down.
 */
export async function connectEnvironment(environmentId: string, label: string, target: EnvironmentTarget): Promise<void> {
  if (target.kind === 'local') {
    // Main opens this connection at boot; the renderer asks again once it
    // mounts. A second connect would drop the live socket and re-hello,
    // losing whatever main had in flight, so an existing connection stays.
    const existing = broker.phaseOf(environmentId)
    if (existing && existing.phase !== 'offline') {
      log('connectEnvironment: local environment already connected; keeping it', { environment_id: environmentId, phase: existing.phase })
      // The window asking is newer than the welcome and the phase: hand
      // both over, or its registry waits on a transition that already
      // happened.
      broker.replayWelcome(environmentId, 'window attached to the kept local connection')
      broker.replayPhase(environmentId)
      return
    }
    broker.connect({
      environmentId,
      label,
      transport: 'local',
      clientId: CLIENT_ID,
      capabilities: DESKTOP_CLIENT_CAPABILITIES,
      open: () => Promise.resolve({ transport: 'local', credential: { kind: 'local' }, socket: connectFnFor(environmentId, target, null, { kind: 'tcp' })() }),
    })
    return
  }
  connectedTargets.set(environmentId, target)
  installWelcomeListener()
  broker.connect({
    environmentId,
    label,
    // What the catalog says this target is reached over; the attempt replaces
    // it with the route it actually took.
    transport: target.kind === 'paired' && target.via === 'relay' ? 'relay' : 'tcp',
    clientId: CLIENT_ID,
    capabilities: DESKTOP_CLIENT_CAPABILITIES,
    open: () => openNonLocal(environmentId, label, target),
  })
  log('connectEnvironment: broker connect requested', { environment_id: environmentId })
}

export function disconnectEnvironment(environmentId: string): void {
  disarmLanReprobe(environmentId)
  connectedTargets.delete(environmentId)
  broker.disconnect(environmentId)
  // An ssh-reached environment's forward has no reason to outlive its
  // connection; a later connect re-opens it. No-op for every other kind.
  sshTunnels.stop(environmentId)
  log('disconnectEnvironment: broker disconnect requested', { environment_id: environmentId })
}

export function restartEnvironment(environmentId: string): void {
  broker.restart(environmentId)
  log('restartEnvironment: broker restart requested', { environment_id: environmentId })
}

/**
 * Redials every remote environment after the Mac wakes. A socket opened on
 * the network the Mac slept on is usually dead on the one it wakes on, and
 * it looks open until the liveness ping or the OS gives up on it; until then
 * the window shows the environment's state from before the sleep. Each
 * restart resolves its route again, so a server now on the same LAN is
 * dialed directly. Returns how many were redialed.
 */
export function renewRemoteEnvironmentsAfterWake(): number {
  const ids = [...connectedTargets.keys()]
  for (const environmentId of ids) broker.restart(environmentId)
  log('remote environments redialed after system wake', { count: ids.length })
  return ids.length
}
