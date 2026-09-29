/**
 * `node dist/clients.js` -- print the devices paired to this server for its
 * owner, and which are connected now, as JSON: `{"devices": PairedDevice[]}`.
 * `ion studio status` runs it so a fleet sees a host's devices over SSH. It
 * asks the running server over the local socket; a stopped server has no
 * live connections to report, so this exits 3.
 *
 * Exit codes: 0 printed; 2 usage; 3 server unreachable or refused.
 */
import { isProcessEntry } from '../entry-guard'
import { resolveLocalStudioTarget, type LocalStudioTarget } from '../local-studio-socket'
import type { PairedDevice } from '@ion/shared/types-environment-admin'
import { dataDir } from '../paths'
import { runLocalAction } from './local-action'

const USAGE = `usage: clients [--timeout-ms <n>]

Prints this server's paired devices for its owner as JSON (dial its local studio.sock).`

export type ClientsCliResult = { ok: true; devices: PairedDevice[] } | { ok: false; error: string }

export async function readPairedDevices(target: LocalStudioTarget, timeoutMs: number): Promise<ClientsCliResult> {
  const result = await runLocalAction(target, { action: 'environment.devices', args: [], timeoutMs, caller: 'clients-cli' })
  if (!result.ok) return result
  if (!Array.isArray(result.value)) return { ok: false, error: 'environment.devices returned an unexpected payload' }
  return { ok: true, devices: result.value as PairedDevice[] }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let timeoutMs = 5_000
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-ms' && Number(argv[i + 1]) > 0) {
      timeoutMs = Number(argv[++i])
      continue
    }
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  let target: LocalStudioTarget
  try {
    target = resolveLocalStudioTarget(dataDir())
  } catch (err) {
    process.stderr.write(`clients: ${err instanceof Error ? err.message : String(err)}\n`)
    return 3
  }
  const result = await readPairedDevices(target, timeoutMs)
  if (!result.ok) {
    process.stderr.write(`clients: ${result.error}\n`)
    return 3
  }
  process.stdout.write(`${JSON.stringify({ devices: result.devices })}\n`)
  return 0
}

// Auto-run only when this module is the process entry point (same rule as main.ts).
if (isProcessEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code }).catch((err: unknown) => {
    process.stderr.write(`clients: ${String(err)}\n`)
    process.exitCode = 3
  })
}
