/**
 * mcp-action-error — the error line an MCP settings action shows when the
 * call itself fails. The two refusals an operator can act on get their cause
 * named: a server running an older Ion that lacks the action, and a device
 * paired without the admin scope. Anything else shows its own message.
 */
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'

export function describeMcpActionError(err: unknown, failed: string, serverLabel: string): string {
  const code = err instanceof StudioActionFailure ? err.code : undefined
  if (code === 'unknown_action') {
    return `${failed}: ${serverLabel} runs an older version of Ion that does not support this. Update Ion on ${serverLabel}, then try again.`
  }
  if (code === 'scope') {
    return `${failed}: this device is not an admin of ${serverLabel}. Pair it again with a link that grants the admin scope.`
  }
  const reason = err instanceof Error ? err.message : String(err)
  return reason ? `${failed}: ${reason}` : failed
}
