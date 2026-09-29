/**
 * Shared EngineConfig field builders for the session-start paths.
 *
 * Split from engine-control-plane.ts (600-line cap): `ensureSession` and
 * `submitPrompt` each build an `EngineConfig` from the same Environment
 * settings, so the resolution lives once here.
 */
import type { RunRecoveryConfig } from '@ion/shared/types-engine'
import { readSettings } from '../persistence/settings-store'

/** Conversation recovery is an Environment setting: one value for the whole server. */
export function resolveRunRecoveryConfig(): RunRecoveryConfig {
  return { enabled: readSettings().tabRecoveryEnabled !== false }
}
