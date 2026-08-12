/**
 * Projectable keys whose canonical storage is engine.json, not settings.json.
 * Both desktop edit surfaces route these through plan-bash-allowlist-store;
 * projection reads them back from engine.json without exposing storage details.
 */
export const ENGINE_CONFIG_BACKED_KEYS: ReadonlySet<string> = new Set([
  'planModeAllowedBashCommands',
])
