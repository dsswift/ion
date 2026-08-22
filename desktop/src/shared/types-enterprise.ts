/**
 * Enterprise policy types (D-004 and descendants).
 *
 * Extracted from types-engine.ts at the 600-line cap split. The blob shapes
 * mirror Go's EnterpriseConfig (engine/internal/types/config.go); the
 * `IonDesktopPolicyFields` namespace is desktop-owned and opaque to the
 * engine. types-engine.ts re-exports everything here so existing imports
 * keep working; new code may import from either entry point.
 */

/**
 * Enterprise resource limits (D-007). Mirrors Go's ResourceLimits in
 * internal/types/config_resource_limits.go. Absent fields mean unlimited.
 */
export interface ResourceLimits {
  /** Maximum concurrent engine sessions. Absent = unlimited. */
  maxSessions?: number
  /** Maximum concurrently-running dispatched agents per session. Absent = unlimited. */
  maxAgentsPerSession?: number
}

/**
 * An enterprise-pinned provider definition (feature 0004). Mirrors Go's
 * ProviderConfig fields the enterprise overrides. apiKey is user-supplied and
 * usually absent from the enterprise block.
 */
export interface EnterpriseProviderDefinition {
  apiKey?: string
  baseURL?: string
  authHeader?: string
  backend?: string
}

/**
 * A single entry in the enterprise extension allowlist (feature 0011 / #308).
 * Mirrors Go's ExtensionAllowlistEntry.
 */
export interface ExtensionAllowlistEntry {
  id: string
  sha256?: string
}

/**
 * The full enterprise policy blob from the engine's get_enterprise_policy RPC
 * (D-004 passthrough). Mirrors Go's EnterpriseConfig in internal/types/config.go.
 * Only the fields the desktop consumes are typed here; the blob may carry
 * more (the engine passes its entire enterprise config through). This is a
 * read-only runtime constraint — never persisted to user settings, never
 * user-editable.
 */
export interface EnterprisePolicy {
  /** Models the enterprise permits. Empty/absent = no restriction. */
  allowedModels?: string[]
  /** Models the enterprise blocks. */
  blockedModels?: string[]
  /** Providers the enterprise permits. Empty/absent = no restriction. */
  allowedProviders?: string[]
  /**
   * Enterprise-pinned provider definitions (feature 0004). Each entry replaces
   * the user-layer provider for the same key (baseURL/authHeader/backend) at
   * config-merge time so the gateway URL cannot be edited by the user. The
   * engine enforces this in EnforceEnterprise; the desktop reads the blob as a
   * read-only runtime constraint. Keyed by provider id.
   */
  providers?: Record<string, EnterpriseProviderDefinition>
  /**
   * Enterprise-owned engine identity config. `requireOperatorIdentity` blocks
   * every session until an interactive operator grant is valid.
   */
  auth?: {
    identityProvider?: string
    requireOperatorIdentity?: boolean
    oauth?: Record<string, unknown>
  }
  /**
   * Extension loading allowlist (feature 0011 / D-020, issue #308). When
   * non-empty, only listed extensions load; an optional per-entry sha256 pins
   * the entry-point integrity. Empty/absent = no restriction. Enforced engine-
   * side at extension load.
   */
  extensionAllowlist?: ExtensionAllowlistEntry[]
  /** Session/agent concurrency caps (sealed ceiling, enforced engine-side). */
  resourceLimits?: ResourceLimits
  /**
   * TTL in days for locally persisted conversations (D-018). The desktop's
   * cleanup job deletes conversations older than this. Absent = no retention
   * policy (conversations kept indefinitely).
   */
  conversationRetentionDays?: number
  /**
   * Opaque client-config namespace. Desktop-specific constraints live under
   * customFields['ion-desktop'] by convention; the engine passes this
   * through without validating or interpreting it.
   */
  customFields?: Record<string, unknown>
}

/**
 * Desktop-specific enterprise constraints carried under
 * customFields['ion-desktop'] in the enterprise policy blob. Schema is owned
 * by the desktop (the engine treats it as opaque). All fields optional —
 * absent means unconstrained.
 */
export interface IonDesktopPolicyFields {
  /** When true, the auto-updater is fully disabled (enterprise-pinned version; D-012). */
  disableAutoUpdate?: boolean
  /**
   * Enterprise theme enforcement. `themeId` names a built-in theme or an
   * MDM-installed theme pack (system root, see main/theme-packs.ts).
   * `locked: true` additionally disables the theme picker on the desktop
   * AND on paired iOS devices (projected via desktop_settings_snapshot);
   * absent/false means the theme is applied as the managed default but the
   * user may still change it.
   */
  themePolicy?: {
    themeId: string
    locked?: boolean
  }
  /**
   * Enterprise active-UI enforcement (single-UI exclusivity). `ui` names
   * the conversation UI ('overlay' | 'studio'); `locked: true` enforces it
   * (the Settings picker is disabled and renderer writes are stripped at
   * the settings funnel). Unlocked = managed default only.
   */
  activeUiPolicy?: {
    ui: string
    locked?: boolean
  }
}
