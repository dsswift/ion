import { readEngineConfig, writeEngineConfig } from './settings-store'
import { log as _log } from './logger'

const TAG = 'PlanBashAllowlist'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Single main-process storage seam for the plan-mode Bash allowlist.
 *
 * The allowlist is ENGINE POLICY — the engine reads it from
 * `~/.ion/engine.json` (`limits.planModeAllowedBashCommands`) fresh at each
 * prompt dispatch. The desktop therefore edits engine.json directly rather
 * than storing a parallel copy in settings.json and pushing it over the wire.
 * Every desktop edit surface (renderer Settings editor IPC, iOS
 * `set_desktop_setting`) funnels through these two functions so there is
 * exactly one place that knows where the list lives. iOS never learns the
 * storage location; it sends a value and the desktop routes it here.
 *
 * Writing engine.json needs NO daemon restart — the engine re-reads the file
 * at the next dispatch (see engine `ResolvePlanModeBashAllowlist`).
 */

/**
 * Read the plan-mode Bash allowlist from engine.json. Returns an empty array
 * when the file is absent, unreadable, or the key is missing — matching the
 * engine's opinionless default (no built-in list; empty = Bash blocked in
 * plan mode). A malformed (non-array) value is treated as empty and logged.
 */
export function readPlanBashAllowlist(): string[] {
  const cfg = readEngineConfig()
  const limits = (cfg.limits && typeof cfg.limits === 'object') ? cfg.limits as Record<string, unknown> : undefined
  const raw = limits?.planModeAllowedBashCommands
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    log('plan_bash_allowlist: engine.json value is not an array, treating as empty', { type: typeof raw })
    return []
  }
  return raw.filter((c): c is string => typeof c === 'string')
}

/**
 * Write the plan-mode Bash allowlist into engine.json's `limits` block,
 * preserving every other field in the file. Persists an explicit empty array
 * (the "block Bash entirely in plan mode" signal) rather than deleting the
 * key, so the operator's intent survives round-trips.
 */
export function writePlanBashAllowlist(cmds: string[]): void {
  const cfg = readEngineConfig()
  const limits = (cfg.limits && typeof cfg.limits === 'object') ? cfg.limits as Record<string, unknown> : {}
  limits.planModeAllowedBashCommands = cmds
  cfg.limits = limits
  writeEngineConfig(cfg)
  log('plan_bash_allowlist: wrote engine.json', { count: cmds.length })
}
