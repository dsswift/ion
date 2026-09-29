/**
 * `ion-studio-server pair` -- mints a pairing link on a headless server.
 *
 * A pairing link is minted by an `admin` caller over the Studio wire
 * (`auth.createPairingLink`), and on a server with no Studio client attached
 * -- a pod, a home-lab Mac reached only over SSH -- there is no caller. This
 * CLI is that caller: it dials the server's own local socket
 * (`<ION_DATA_DIR>/studio.sock`, or the per-user named pipe on Windows), which the `local` credential door trusts
 * implicitly for same-machine processes and grants every scope, sends the
 * action, and prints the link. Run it ON the server host:
 *
 *   ION_DATA_DIR=/var/lib/ion node dist/pair.js --label "josh laptop"
 *
 * Prints the `ion-studio://pair?code=…&url=…&env=…` link the desktop's
 * Add Environment dialog consumes. The link is single-use and expires in
 * five minutes (`auth/pairing-links.ts`).
 *
 * Exit codes: 0 link printed; 2 usage; 3 server unreachable or refused.
 */
import { isProcessEntry } from '../entry-guard'
import { resolveLocalStudioTarget, type LocalStudioTarget } from '../local-studio-socket'
import { runLocalAction } from './local-action'
import { SCOPES, type Scope } from '@ion/shared/studio-wire/types'
import { dataDir } from '../paths'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('cli-pair', msg, fields)
}

export interface PairCliOptions {
  label: string
  scopes: Scope[] | undefined
  json: boolean
  /** Also open a relay pairing channel and name it in the link, for a client off the LAN. */
  relay: boolean
  /** The human the joining device belongs to (isolated tenancy): the device acts as `user:<name>`. */
  as?: string
  /** Mint a short discovery code (typed into Add Environment -> Nearby) instead of a link. */
  code?: boolean
  timeoutMs: number
}

const USAGE = `usage: pair [--label <client label>] [--as <person>] [--scopes a,b,c] [--json] [--relay] [--timeout-ms <n>]

Mints a one-time pairing link on THIS server (dial its local studio.sock).
  --label       Label recorded for the joining client (default: "paired client").
  --as          The person the joining device belongs to; the device acts as user:<person>.
                Only on an isolated-tenancy install: a shared install has one person, its owner.
  --scopes      Comma-separated scopes to grant (default: server.json pairing.defaultScopes).
  --json        Print {url, code, expiresAt} as JSON instead of the link line.
  --relay       Also open a relay pairing channel (needs a configured relay) so a client off the LAN can pair.
  --code        Mint a short one-time code instead of a link, for a desktop that found this server under
                Add Environment -> Nearby (needs server.json discovery.advertise, or an open discovery window).
  --timeout-ms  How long to wait for the server (default 10000).`

export function parsePairArgs(argv: string[]): { ok: true; options: PairCliOptions } | { ok: false; error: string } {
  const options: PairCliOptions = { label: 'paired client', scopes: undefined, json: false, relay: false, timeoutMs: 10_000 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string | undefined => argv[++i]
    switch (arg) {
      case '--label': {
        const v = next()
        if (!v) return { ok: false, error: '--label needs a value' }
        options.label = v
        break
      }
      case '--as': {
        const v = next()
        if (!v) return { ok: false, error: '--as needs a value' }
        options.as = v
        break
      }
      case '--scopes': {
        const v = next()
        if (!v) return { ok: false, error: '--scopes needs a value' }
        const parts = v.split(',').map((s) => s.trim()).filter(Boolean)
        const bad = parts.filter((s) => !(SCOPES as readonly string[]).includes(s))
        if (bad.length > 0) return { ok: false, error: `unknown scope(s): ${bad.join(', ')} (valid: ${SCOPES.join(', ')})` }
        options.scopes = parts as Scope[]
        break
      }
      case '--json':
        options.json = true
        break
      case '--timeout-ms': {
        const v = Number(next())
        if (!Number.isFinite(v) || v <= 0) return { ok: false, error: '--timeout-ms needs a positive number' }
        options.timeoutMs = v
        break
      }
      case '--relay':
        options.relay = true
        break
      case '--code':
        options.code = true
        break
      case '-h':
      case '--help':
        return { ok: false, error: USAGE }
      default:
        return { ok: false, error: `unknown argument ${arg}\n${USAGE}` }
    }
  }
  return { ok: true, options }
}

export type PairCliResult =
  | { ok: true; url: string; code: string; expiresAt: number; environmentId: string; environmentLabel: string }
  | { ok: false; error: string }

/**
 * Dials `target` as a local-door client and runs `auth.createPairingLink`.
 * Pure over its inputs so a test can point it at a listener it started
 * itself; `main()` below supplies the real data-dir target.
 */
export async function mintPairingLink(target: LocalStudioTarget, options: PairCliOptions): Promise<PairCliResult> {
  // --code asks for the short code a desktop types after finding this
  // server under Add Environment -> Nearby; otherwise a link.
  const action = options.code ? 'environment.discovery.mintCode' : 'auth.createPairingLink'
  const args = options.code
    ? []
    : [{ label: options.label, ...(options.scopes ? { scopes: options.scopes } : {}), ...(options.relay ? { relay: true } : {}), ...(options.as ? { as: options.as } : {}) }]
  const result = await runLocalAction(target, { action, args, timeoutMs: options.timeoutMs, caller: 'pair-cli' })
  if (!result.ok) return result
  const { environmentId, environmentLabel } = result
  const value = result.value as { url?: unknown; code?: unknown; expiresAt?: unknown } | undefined
  if (options.code) {
    if (!value || typeof value.code !== 'string' || typeof value.expiresAt !== 'number') {
      return { ok: false, error: 'environment.discovery.mintCode returned an unexpected payload' }
    }
    log('discovery code minted', { environment_id: environmentId, expires_at: value.expiresAt })
    return { ok: true, url: '', code: value.code, expiresAt: value.expiresAt, environmentId, environmentLabel }
  }
  if (!value || typeof value.url !== 'string' || typeof value.code !== 'string' || typeof value.expiresAt !== 'number') {
    return { ok: false, error: 'auth.createPairingLink returned an unexpected payload' }
  }
  log('pairing link minted', { environment_id: environmentId, expires_at: value.expiresAt })
  return { ok: true, url: value.url, code: value.code, expiresAt: value.expiresAt, environmentId, environmentLabel }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parsePairArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`)
    return 2
  }
  let target: LocalStudioTarget
  try {
    target = resolveLocalStudioTarget(dataDir())
  } catch (err) {
    process.stderr.write(`pair: ${err instanceof Error ? err.message : String(err)}\n`)
    return 3
  }
  const result = await mintPairingLink(target, parsed.options)
  if (!result.ok) {
    process.stderr.write(`pair: ${result.error}\n`)
    return 3
  }
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify({ url: result.url, code: result.code, expiresAt: result.expiresAt, environmentId: result.environmentId, environmentLabel: result.environmentLabel })}\n`)
  } else if (parsed.options.code) {
    process.stdout.write(`${result.code}\n`)
    process.stderr.write(`environment ${result.environmentLabel} (${result.environmentId}); type this code under Add Environment -> Nearby; it expires at ${new Date(result.expiresAt).toISOString()}\n`)
  } else {
    process.stdout.write(`${result.url}\n`)
    process.stderr.write(`environment ${result.environmentLabel} (${result.environmentId}); link expires at ${new Date(result.expiresAt).toISOString()}\n`)
  }
  return 0
}

// Auto-run only when this module is the process entry point (same rule as main.ts).
if (isProcessEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code }).catch((err: unknown) => {
    process.stderr.write(`pair: ${String(err)}\n`)
    process.exitCode = 3
  })
}
