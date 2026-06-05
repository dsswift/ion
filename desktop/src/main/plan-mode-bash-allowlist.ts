import { readSettings } from './settings-store'
import { log as _log } from './logger'

const TAG = 'PlanModeBashAllowlist'
function log(msg: string): void { _log(TAG, msg) }

/**
 * Resolves the plan-mode bash command allowlist from the desktop's
 * persisted user preference. Returns one of three concrete shapes:
 *
 *   - `string[]` (including the empty array) — the user's preference
 *     is honored verbatim. The empty-array case is the "explicitly
 *     clear allowlist; block Bash entirely" path the engine treats as
 *     the second tri-valued branch (per `docs/protocol/client-commands.md`
 *     § `set_plan_mode`).
 *   - `undefined` — the read failed (`readSettings` threw), or the
 *     preference key is missing / not an array. The engine treats this
 *     as "no change to existing allowlist."
 *
 * The previous in-line implementations in `engine-control-plane.ts`
 * (`setPermissionMode`) and `prompt-pipeline.ts` (`handleSlash` for
 * slash-command frontmatter merging) both swallowed the empty-array
 * case via `if (cmds && cmds.length > 0)`, silently demoting an
 * explicit user clear to a no-op on the engine side. The helper exists
 * so the projection is consistent across all callers and the
 * tri-valued contract is honored end-to-end.
 *
 * The catch path logs the failure (per `desktop/AGENTS.md` "no silent
 * catch") so operators debugging "my allowlist isn't being honored"
 * can distinguish a thrown read from a missing-key read in
 * `~/.ion/desktop.log`. The log message names the consequence — the
 * engine keeps the prior allowlist — so the log line is actionable
 * standing alone.
 *
 * @returns the resolved allowlist, or `undefined` when the read failed
 *          or the field is absent.
 */
export function resolveBashAllowlistFromSettings(): string[] | undefined {
  let settings: Record<string, any>
  try {
    settings = readSettings()
  } catch (err) {
    log(`resolveBashAllowlistFromSettings: readSettings threw; returning undefined (engine keeps prior allowlist): ${err}`)
    return undefined
  }
  const cmds = settings.planModeAllowedBashCommands
  if (!Array.isArray(cmds)) {
    return undefined
  }
  return cmds
}
