// event-wiring-tool-names.ts — the display-name ingest arm for engine events.
//
// A delegated-CLI run names the engine's own tools `mcp__ion-extensions__<tool>`
// (see @ion/shared/tool-names). The engine emits that name verbatim, and the
// model keeps calling it by that name; only what a person reads changes. This
// runs once, on the raw engine event as the bridge receives it
// (engine-bridge-core.ts), BEFORE any listener sees it, so the control plane
// that feeds the store, the thin-client wire projection, and the notification
// path all carry the bare name and no surface has to know the bridge exists.

import { stripEngineBridgePrefix } from '@ion/shared/tool-names'
import { log as _log } from '../logger'

const log = (msg: string, fields?: Record<string, unknown>) => _log('event-wiring-tool-names', msg, fields)

interface NamedDenial {
  toolName?: string
}

interface ToolNamedEvent {
  type?: string
  toolId?: string
  toolName?: string
  permToolName?: string
  fields?: { permissionDenials?: NamedDenial[] }
}

/**
 * Rewrite one name field in place. Returns the name as it arrived on the wire
 * when it changed, so the caller can log it: every log line written after this
 * point carries the bare name, and the wire name would otherwise be gone from
 * the server's logs.
 */
function unwrapField(target: { [k: string]: unknown }, key: string): string | null {
  const current = target[key]
  if (typeof current !== 'string') return null
  const bare = stripEngineBridgePrefix(current)
  if (bare === current) return null
  target[key] = bare
  return current
}

/**
 * Strip the engine bridge prefix from every display-facing tool name on an
 * inbound engine event. MUTATES the event, like the agent-state ingest, so every
 * downstream copy carries the bare name.
 *
 * Deliberately untouched: `gateToolName` on `engine_tool_gate`. That is a policy
 * input, not a label, and the gate normalizes it itself where it decides.
 */
export function applyToolDisplayNames(event: ToolNamedEvent): void {
  const wireNames: string[] = []
  const note = (wire: string | null) => { if (wire) wireNames.push(wire) }
  switch (event.type) {
    case 'engine_tool_start':
    case 'engine_tool_stalled':
    case 'engine_dispatch_activity':
      note(unwrapField(event as { [k: string]: unknown }, 'toolName'))
      break
    case 'engine_permission_request':
      note(unwrapField(event as { [k: string]: unknown }, 'permToolName'))
      break
    case 'engine_status':
      for (const denial of event.fields?.permissionDenials ?? []) {
        note(unwrapField(denial as { [k: string]: unknown }, 'toolName'))
      }
      break
    default:
      return
  }
  // INFO, not debug: it fires once per bridged call, the same cadence as the
  // tool_start line it explains, and the wire name is the only record here that
  // the call went through the engine's MCP bridge.
  if (wireNames.length > 0) {
    log('display name stripped from engine bridge tool', {
      type: event.type,
      tool_id: event.toolId ?? '',
      wire_names: wireNames.join(','),
    })
  }
}
