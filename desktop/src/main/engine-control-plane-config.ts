/**
 * Shared EngineConfig field builders for the session-start paths.
 *
 * Split from engine-control-plane.ts (600-line cap): `ensureSession` and
 * `submitPrompt` each build an `EngineConfig` with the same claudeCompat
 * resolution and the same tool-gate declaration. Two independent inline
 * IIFEs for the identical fallback logic is exactly the kind of duplication
 * this split removes — not a line-count exercise, a real de-duplication.
 */
import type { RunRecoveryConfig } from '../shared/types-engine'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { warn } from './logger'

/**
 * Resolve the effective claudeCompat setting, falling back to the default on
 * any read failure (a missing or malformed settings file must never abort a
 * session start).
 */
export function resolveRunRecoveryConfig(): RunRecoveryConfig {
  return { enabled: readSettings().tabRecoveryEnabled !== false }
}

export function resolveClaudeCompat(): boolean {
  try {
    return readSettings().enableClaudeCompat ?? SETTINGS_DEFAULTS.enableClaudeCompat
  } catch (err) {
    warn('control-plane', 'resolveClaudeCompat falling back to default', { error: String(err) })
    return SETTINGS_DEFAULTS.enableClaudeCompat
  }
}
