/**
 * provider-action-error — the error line a provider action shows. A
 * `studio_action` a remote server refused for lack of scope reads as "this
 * device is not an admin there", never as a generic failure: provider writes
 * need the `admin` scope, and a LAN pairing link minted without it is the
 * usual cause.
 */
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

export function describeProviderActionError(err: unknown, environmentId: string): string {
  const code = err instanceof StudioActionFailure ? err.code : undefined
  if (code === 'scope' && environmentId !== LOCAL_ENVIRONMENT_ID) {
    return `This device is not an admin of the ${environmentId} environment. Pair it again with a link that grants the admin scope (ion studio pair --scopes admin,...).`
  }
  return err instanceof Error ? err.message : String(err)
}
