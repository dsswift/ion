/**
 * host-name — the name this server identifies its host by in logs,
 * telemetry, pushes, and diagnostics: `ION_HOST_NAME` when set, else the OS
 * hostname, without macOS's `.local` suffix.
 *
 * A container's hostname is its pod name, new on every restart. A deployment
 * sets `ION_HOST_NAME` to a name that outlives the pod (its public DNS name),
 * so every restart reports as the same host. The engine honors the same
 * variable. Network uses (addresses, discovery, pairing links) read the OS
 * hostname directly; this is identity only.
 */
import { hostname } from 'os'

export const HOST_NAME_ENV = 'ION_HOST_NAME'

export function hostName(env: NodeJS.ProcessEnv = typeof process === 'undefined' ? {} : process.env): string {
  const override = env[HOST_NAME_ENV]?.trim()
  return (override || hostname()).replace(/\.local$/, '')
}
