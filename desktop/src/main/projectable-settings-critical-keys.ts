/**
 * Settings whose updates affect active connection behavior.
 *
 * Kept separate from the projectable settings array so the data module stays
 * below the TypeScript file-size cap. Tests import this through the data
 * module's re-export.
 */
export const CONNECTION_CRITICAL_KEYS = [
  'soundEnabled',
  'streamThinkingToRemote',
  'tabRecoveryEnabled',
] as const
