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
  maxSessions?: number;
  /** Maximum concurrently-running dispatched agents per session. Absent = unlimited. */
  maxAgentsPerSession?: number;
}

/**
 * An enterprise-pinned provider definition (feature 0004). Mirrors Go's
 * ProviderConfig fields the enterprise overrides. apiKey is user-supplied and
 * usually absent from the enterprise block.
 */
export interface EnterpriseProviderDefinition {
  apiKey?: string;
  baseURL?: string;
  authHeader?: string;
  backend?: string;
}

/**
 * A single entry in the enterprise extension allowlist (feature 0011 / #308).
 * Mirrors Go's ExtensionAllowlistEntry.
 */
export interface ExtensionAllowlistEntry {
  id: string;
  sha256?: string;
}

/**
 * How the engine resolved policy on an installation an administrator marked
 * as managed. Mirrors Go's ManagedModeStatus. The engine stamps it; a policy
 * source cannot set it.
 */
export interface ManagedModeStatus {
  managed: boolean;
  /** No machine policy resolved. The engine refuses every prompt. */
  policyAbsent?: boolean;
  /** ION_ENTERPRISE_CONFIG was set and ignored. */
  overrideRefused?: boolean;
}

/**
 * Why enterprise enforcement displaced a lower-layer config value. Mirrors
 * Go's PolicyOverrideReason. A stable code a client maps to its own text; the
 * engine may add codes, so an unknown one is a plain string.
 */
export type PolicyOverrideReason =
  | "managed_provider_pinned"
  | "provider_not_allowed"
  | "model_not_allowed"
  | "model_blocked"
  | "mcp_server_denied"
  | "mcp_server_not_allowed"
  | (string & {});

/**
 * One user or project config value that enterprise enforcement replaced or
 * removed. Mirrors Go's PolicyOverride. Present only when the value in effect
 * differs from the one the lower layer supplied.
 */
export interface PolicyOverride {
  /** Config path in engine.json spelling, e.g. `providers.<key>.baseURL`. */
  field: string;
  reason: PolicyOverrideReason;
  /** The displaced value. Absent for a removed entry and for a secret field. */
  userValue?: string;
  /** The value in effect. Absent when removed outright and for a secret field. */
  effectiveValue?: string;
}

/**
 * The managed files an administrator projects over the engine and model
 * configuration. Mirrors Go's ManagedConfigSource. A declared surface is owned
 * in full: the user and project files contribute nothing to it.
 */
export interface ManagedConfigSource {
  /** Absolute path of the managed engine configuration file. */
  enginePath?: string;
  /** Absolute path of the managed model configuration file. */
  modelsPath?: string;
  schemaVersion: number;
  /**
   * Turns off the user's own MCP servers on a managed engine file. By default
   * a user may add servers beside the managed file's.
   */
  disableUserMcpServers?: boolean;
}

/**
 * Whether a policy stops users adding their own MCP servers: a managed engine
 * file is declared, and either policy turned user servers off or the file
 * could not be applied.
 */
export function userMcpServersLocked(
  policy: EnterprisePolicy | null | undefined,
): boolean {
  const engine = policy?.managedConfigStatus?.engine;
  if (!engine) return false;
  return (
    policy?.managedConfig?.disableUserMcpServers === true || !engine.projected
  );
}

/** One declared managed surface's outcome. Mirrors Go's ManagedSurfaceStatus. */
export interface ManagedSurfaceStatus {
  /** The managed file was read and applied in full. */
  projected: boolean;
  /** `sha256:<hex>` of the managed file's bytes. */
  checksum?: string;
  /** Why the managed file was not applied. The surface then holds defaults. */
  error?: string;
}

/**
 * How the engine resolved a ManagedConfigSource. Mirrors Go's
 * ManagedConfigStatus. The engine stamps it; a policy source cannot set it.
 * It never carries configuration content.
 */
export interface ManagedConfigStatus {
  schemaVersion: number;
  supportedSchemaVersion: number;
  /** Absent when no managed engine file is declared. */
  engine?: ManagedSurfaceStatus;
  /** Absent when no managed models file is declared. */
  models?: ManagedSurfaceStatus;
}

/** The result code of a config write refused because its surface is managed. */
export const MANAGED_CONFIG_WRITE_REFUSED = "managed_config_write_refused";

/**
 * The full enterprise policy blob from the engine's get_enterprise_policy RPC
 * (D-004 passthrough). Mirrors Go's EnterpriseConfig in internal/types/config.go.
 * Only the fields the desktop consumes are typed here; the blob may carry
 * more (the engine passes its entire enterprise config through). This is a
 * read-only runtime constraint — never persisted to user settings, never
 * user-editable.
 */
export interface EnterprisePolicy {
  /** Present only on an installation carrying the managed-mode marker. */
  managedMode?: ManagedModeStatus;
  /** Lower-layer config values enforcement displaced, sorted by field. Engine-stamped. */
  overrides?: PolicyOverride[];
  /** Managed files projected over the engine and model configuration. */
  managedConfig?: ManagedConfigSource;
  /** Present only when managedConfig declares a surface. */
  managedConfigStatus?: ManagedConfigStatus;
  /** Models the enterprise permits. Empty/absent = no restriction. */
  allowedModels?: string[];
  /** Models the enterprise blocks. */
  blockedModels?: string[];
  /** Providers the enterprise permits. Empty/absent = no restriction. */
  allowedProviders?: string[];
  /**
   * Enterprise-pinned provider definitions (feature 0004). Each entry replaces
   * the user-layer provider for the same key (baseURL/authHeader/backend) at
   * config-merge time so the gateway URL cannot be edited by the user. The
   * engine enforces this in EnforceEnterprise; the desktop reads the blob as a
   * read-only runtime constraint. Keyed by provider id.
   */
  providers?: Record<string, EnterpriseProviderDefinition>;
  /**
   * Enterprise-owned engine identity config. `requireOperatorIdentity` blocks
   * every session until an interactive operator grant is valid.
   */
  auth?: {
    identityProvider?: string;
    requireOperatorIdentity?: boolean;
    oauth?: Record<string, unknown>;
  };
  /**
   * Extension loading allowlist (feature 0011 / D-020, issue #308). When
   * non-empty, only listed extensions load; an optional per-entry sha256 pins
   * the entry-point integrity. Empty/absent = no restriction. Enforced engine-
   * side at extension load.
   */
  extensionAllowlist?: ExtensionAllowlistEntry[];
  /** Session/agent concurrency caps (sealed ceiling, enforced engine-side). */
  resourceLimits?: ResourceLimits;
  /**
   * TTL in days for locally persisted conversations (D-018). The desktop's
   * cleanup job deletes conversations older than this. Absent = no retention
   * policy (conversations kept indefinitely).
   */
  conversationRetentionDays?: number;
  newConversationDefaults?: {
    baseDirectory?: string;
    profileName?: string;
    profileLocked?: boolean;
    engineProfileId?: string;
    locked?: boolean;
    projects?: Array<{
      directory: string;
      name?: string;
      default?: boolean;
      profileName?: string;
      profileLocked?: boolean;
    }>;
  };
  /**
   * Suppresses the desktop's operator notifications for
   * engine_telemetry_health observations (issue #379). The desktop still
   * logs every observation regardless of this flag; it only controls
   * whether a Notification interrupts the operator. Read per-event by
   * `installTelemetryHealthConsumer`, not captured once, so a policy change
   * takes effect immediately.
   */
  disableTelemetryHealthNotifications?: boolean;
  /**
   * Opaque client-config namespace. Desktop-specific constraints live under
   * customFields['ion-desktop'] by convention; the engine passes this
   * through without validating or interpreting it.
   */
  customFields?: Record<string, unknown>;
  /**
   * Replacement text per Policy Failure identifier (see policy-failure.ts).
   * The engine applies it to the failures it reports; a client applies it to
   * the failures it words itself.
   */
  messages?: Record<string, string>;
  /**
   * Administrator-defined asset scopes that apply to the account this policy
   * was resolved for, in policy order. Stamped by the engine from the account
   * policies that matched; a consumer maps a scope to its own on-disk
   * location (theme packs: `accounts/<scope>/themes` beside the system root).
   */
  assetScopes?: string[];
}

/**
 * Server-enforced Environment constraints carried under
 * customFields['ion-server']. Schema is owned by Ion Studio Server; the
 * engine treats it as opaque and republishes it with the rest of the blob, so
 * every client connected to that Environment reads the same seal.
 */
export interface IonServerPolicyFields {
  /**
   * Seals the "Allow settings edits by the agent" Environment setting. When
   * present, `allowed` is the value in force: the server refuses every save
   * of that setting, and the settings-files guard reads this instead of the
   * saved value. Absent means the server's admins decide.
   */
  agentSettingsEdits?: {
    allowed: boolean;
  };
  /**
   * The mutability class of this server's Environment and Account settings,
   * per key (`enterprise-settings-policy`). Enforced for every connection.
   */
  settingsPolicy?: import("./enterprise-settings-policy").SettingsPolicyFields;
  /**
   * The developer surfaces this server offers. A surface set to
   * `"disabled"` is refused for every connection, and no client connected
   * to this Environment shows a control for it. Absent means every surface
   * is offered.
   */
  developerSurfaces?: import("./developer-surfaces").DeveloperSurfacesConfig;
}

/**
 * Desktop-specific enterprise constraints carried under
 * customFields['ion-desktop'] in the enterprise policy blob. Schema is owned
 * by the desktop (the engine treats it as opaque). All fields optional —
 * absent means unconstrained.
 */
export interface IonDesktopPolicyFields {
  /** When true, the auto-updater is fully disabled (enterprise-pinned version; D-012). */
  disableAutoUpdate?: boolean;
  /**
   * Enterprise theme enforcement. `themeId` names a built-in theme or an
   * MDM-installed theme pack (system root, see main/theme-packs.ts).
   * `locked: true` additionally disables the theme picker on the desktop
   * AND on paired iOS devices (projected via desktop_settings_snapshot);
   * absent/false means the theme is applied as the managed default but the
   * user may still change it.
   */
  themePolicy?: {
    themeId: string;
    locked?: boolean;
  };
  /**
   * What the macOS installer package does when Ion is running. The package
   * scripts read this straight from the Managed Preferences payload
   * (`desktop/scripts/pkg-scripts/ion-pkg-common.sh`); the running desktop
   * never consults it.
   */
  installer?: {
    /**
     * `refuse` (the default) fails the install and leaves Ion running.
     * `replace` stops Ion, replaces the bundle, and succeeds: the unattended
     * path for a managed push.
     */
    runningApp?: "refuse" | "replace";
    /** Seconds `replace` waits for the graceful drain before forcing the quit. */
    drainTimeoutSeconds?: number;
  };
  /** Managed declarative desktop automations. Never persisted to user files. */
  automation?: import("./types-automation").EnterpriseAutomationPolicy;
  /**
   * Which servers this desktop may add to its own catalog (`mode`, `allowed`,
   * `locked`; see `deriveDesktopEnvironmentPolicy`). Device policy: it
   * governs this machine only and never travels to another client.
   */
  environmentPolicy?: Record<string, unknown>;
  /**
   * Managed catalog entries (manifest C11, engine children 02/03): servers
   * IT provisions for this machine (machine layer) or this specific person
   * (per-user layer, engine `enterprise_user.go`). The desktop merges these
   * into `desktop.json`'s `environments[]` as `managed: true` entries via
   * the one-shot `managed-defaults.ts` marker (id `'environments'`) —
   * additive only, never a source of removal or lock. Shape mirrors
   * `EnvironmentTarget` (`types-environments.ts`) minus the local-only kind.
   */
  environments?: Array<Record<string, unknown>>;
  /**
   * Task 10 settings partition: additional settings-dialog groups to hide
   * from the LOCAL desktop connection specifically (group ids from
   * `@ion/shared/settings-classification`). Every non-local connection
   * already has every `environment`-classified group hidden regardless of
   * this field; this is the sealed-config override for the local desktop,
   * which is otherwise trusted to see everything. Absent/empty = the local
   * desktop sees every group.
   */
  hiddenSettingsGroups?: string[];
  /**
   * The mutability class of this desktop's Personal and Device settings, per
   * key (`enterprise-settings-policy`). Device policy: it governs the desktop
   * it is installed on, never a client visiting from elsewhere.
   */
  settingsPolicy?: import("./enterprise-settings-policy").SettingsPolicyFields;
  /**
   * The developer surfaces this desktop shows, whichever server a
   * conversation is on. Device policy: it never travels to another client.
   * To switch a surface off for everyone who connects to a server, set
   * `customFields['ion-server'].developerSurfaces` on that server instead.
   */
  developerSurfaces?: import("./developer-surfaces").DeveloperSurfacesConfig;
}
