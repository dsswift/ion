/**
 * The local environment's label for this window, resolved once from the
 * host's platform the way `platform/mod-key.ts` resolves the command key:
 * "This Mac" on macOS, "This PC" on Windows and Linux. A host double with no
 * operating-system shell reads as macOS.
 */
import { localEnvironmentLabel } from '@ion/shared/types-environments'
import { host } from '../../host/host-instance'

function hostPlatform(): string | undefined {
  const caps: unknown = typeof host.capabilities === 'function' ? host.capabilities() : undefined
  return Array.isArray(caps) && caps.includes('nativeShell') ? host.shell.platform : undefined
}

export const LOCAL_ENVIRONMENT_LABEL = localEnvironmentLabel(hostPlatform())
