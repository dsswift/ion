package config

import (
	"net/url"
	"path"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// MergeConfigs merges layered configs with later configs overriding earlier ones.
// Enterprise enforcement is applied separately via EnforceEnterprise.
func MergeConfigs(enterprise *types.EnterpriseConfig, configs ...*types.EngineRuntimeConfig) *types.EngineRuntimeConfig {
	var result *types.EngineRuntimeConfig
	for _, cfg := range configs {
		if cfg == nil {
			continue
		}
		if result == nil {
			dup := *cfg
			// Deep copy maps to avoid mutation
			if cfg.McpServers != nil {
				dup.McpServers = make(map[string]types.McpServerConfig, len(cfg.McpServers))
				for k, v := range cfg.McpServers {
					dup.McpServers[k] = v
				}
			}
			if cfg.Providers != nil {
				dup.Providers = make(map[string]types.ProviderConfig, len(cfg.Providers))
				for k, v := range cfg.Providers {
					dup.Providers[k] = v
				}
			}
			if cfg.Profiles != nil {
				dup.Profiles = make([]types.EngineProfileConfig, len(cfg.Profiles))
				copy(dup.Profiles, cfg.Profiles)
			}
			if cfg.RunRecovery != nil {
				cp := *cfg.RunRecovery
				dup.RunRecovery = &cp
			}
			result = &dup
			continue
		}
		mergeInto(result, cfg)
	}
	if result == nil {
		return DefaultConfig()
	}
	return result
}

// EnforceEnterprise applies enterprise constraints as a sealed ceiling.
// Called after all other merges. Enterprise rules cannot be weakened.
func EnforceEnterprise(config *types.EngineRuntimeConfig, enterprise *types.EnterpriseConfig) *types.EngineRuntimeConfig {
	result := *config

	// Deep copy McpServers so deletes don't mutate the input
	if config.McpServers != nil {
		result.McpServers = make(map[string]types.McpServerConfig, len(config.McpServers))
		for k, v := range config.McpServers {
			result.McpServers[k] = v
		}
	}

	// Model restrictions: defaultModel must be in allowedModels
	if len(enterprise.AllowedModels) > 0 {
		if !contains(enterprise.AllowedModels, result.DefaultModel) {
			utils.Log("ConfigMerge", "enterprise: defaultModel \""+result.DefaultModel+"\" not in allowedModels, falling back to \""+enterprise.AllowedModels[0]+"\"")
			result.DefaultModel = enterprise.AllowedModels[0]
		}
	}

	// Blocked models: if defaultModel is blocked, fall back to the first
	// allowed model, or to no default at all when the policy names no
	// allowed models either. Inventing an unrelated model id here would
	// mask the fact that enterprise policy has blocked every model the
	// operator actually configured -- empty surfaces that as the same clear
	// "no model configured" failure an unconfigured engine already produces
	// (runloop_provider_resolve.go), rather than silently substituting a
	// model the policy never vetted.
	if contains(enterprise.BlockedModels, result.DefaultModel) {
		fallback := ""
		if len(enterprise.AllowedModels) > 0 {
			fallback = enterprise.AllowedModels[0]
		}
		utils.Log("ConfigMerge", "enterprise: defaultModel \""+result.DefaultModel+"\" is blocked, falling back to \""+fallback+"\"")
		result.DefaultModel = fallback
	}

	// Enterprise identity config is sealed. Provider identity and OAuth client
	// details come from enterprise when present. Requirement composes one-way:
	// either lower or enterprise config can require an operator, but enterprise
	// false never weakens a lower-layer true.
	if enterprise.Auth != nil {
		required := enterprise.Auth.RequireOperatorIdentity || (result.Auth != nil && result.Auth.RequireOperatorIdentity)
		authCopy := *enterprise.Auth
		authCopy.RequireOperatorIdentity = required
		result.Auth = &authCopy
		utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: identity configuration applied", map[string]any{
			"provider": authCopy.IdentityProvider, "require_operator_identity": authCopy.RequireOperatorIdentity,
		})
	}

	// Provider restrictions -- allow list (D-005). When the enterprise
	// declares AllowedProviders, every provider not on the list is stripped
	// from the merged config so a hand-edited ~/.ion/engine.json cannot
	// route model traffic around the enterprise gateway. Same sealed-ceiling
	// prune pattern as the MCP allowlist below: re-applied on every config
	// load, so edits do not survive.
	if len(enterprise.AllowedProviders) > 0 && result.Providers != nil {
		// Deep copy Providers so deletes don't mutate the input.
		pruned := make(map[string]types.ProviderConfig, len(result.Providers))
		for k, v := range result.Providers {
			pruned[k] = v
		}
		for key := range pruned {
			if !contains(enterprise.AllowedProviders, key) {
				utils.Log("ConfigMerge", "enterprise: removing non-allowlisted provider \""+key+"\"")
				recordEnforcement(EnforcementProviderPruned, key, "allowlist", nil)
				delete(pruned, key)
			}
		}
		result.Providers = pruned
	}

	// Provider definition pinning (feature 0004 root-cause fix). AllowedProviders
	// above strips providers by KEY, but an allowed provider's BaseURL / AuthHeader
	// / Backend stay user-editable in ~/.ion/engine.json — the gateway bypass
	// survives one field deeper. Enterprise-declared provider definitions close
	// that residual: each replaces the user-layer definition for the same key
	// WHOLESALE (not a field-merge — a partial merge would let a user-supplied
	// baseURL survive an enterprise block that omitted it). The single exception
	// is APIKey: enterprise blocks routinely omit it because per-user keys are
	// user-supplied, so an empty enterprise APIKey preserves the user's key while
	// BaseURL/AuthHeader/Backend always come from the enterprise block. Declared
	// keys are implicitly allowed (union with AllowedProviders). Re-applied on
	// every load, so edits do not survive. Both branches logged.
	if len(enterprise.Providers) > 0 {
		pinned := make(map[string]types.ProviderConfig, len(result.Providers)+len(enterprise.Providers))
		for k, v := range result.Providers {
			pinned[k] = v
		}
		for key, entProvider := range enterprise.Providers {
			userProvider, hadUser := pinned[key]
			// Whole-value replace with the ONE exception: an empty enterprise
			// APIKey preserves the user-layer key (per-user keys are user-supplied).
			if entProvider.APIKey == "" && hadUser && userProvider.APIKey != "" {
				entProvider.APIKey = userProvider.APIKey
				utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: pinning provider definition, preserving user apiKey", map[string]any{"provider": key, "baseURL": entProvider.BaseURL})
			} else {
				utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: pinning provider definition", map[string]any{"provider": key, "baseURL": entProvider.BaseURL, "had_user_entry": hadUser})
			}
			recordEnforcement(EnforcementProviderPinned, key, "pin", map[string]any{"base_url": entProvider.BaseURL})
			pinned[key] = entProvider
		}
		result.Providers = pinned
	}
	// MCP server restrictions -- deny list
	if len(enterprise.McpDenylist) > 0 && result.McpServers != nil {
		for _, denied := range enterprise.McpDenylist {
			if _, ok := result.McpServers[denied]; ok {
				utils.Log("ConfigMerge", "enterprise: removing denied MCP server \""+denied+"\"")
				recordEnforcement(EnforcementMcpPruned, denied, "denylist", nil)
				delete(result.McpServers, denied)
			}
		}
	}

	// MCP server restrictions -- allow list. A server passes when its config
	// key is on the allowlist (exact match) OR its configured URL host
	// glob-matches an allowlist pattern (D-010: "*.dcim.com" admits any
	// server whose URL host is a dcim.com subdomain, regardless of what the
	// server entry is named). Host matching closes the rename bypass: a
	// name-only allowlist lets a constrained user point a server named
	// "internal-tools" anywhere; host patterns pin the actual destination.
	if len(enterprise.McpAllowlist) > 0 && result.McpServers != nil {
		for key, server := range result.McpServers {
			if contains(enterprise.McpAllowlist, key) {
				continue
			}
			if host := mcpServerURLHost(server); host != "" && matchesAny(enterprise.McpAllowlist, host) {
				utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: MCP server allowed by URL host pattern", map[string]any{"server": key, "url_host": host})
				continue
			}
			utils.Log("ConfigMerge", "enterprise: removing non-allowlisted MCP server \""+key+"\"")
			recordEnforcement(EnforcementMcpPruned, key, "allowlist", nil)
			delete(result.McpServers, key)
		}
	}

	// Plugin policy: merge enterprise force-installs, replace allowlist (sealed
	// ceiling), append denylist (additive). Follows the same pattern as MCP
	// restrictions above, extended to cover the downloadable-artifact dimension.
	if len(enterprise.PluginForceInstalled) > 0 {
		if result.Plugins == nil {
			result.Plugins = &types.PluginsConfig{}
		}
		// Union: add enterprise force-installs not already in the user list.
		existing := make(map[string]bool, len(result.Plugins.ForceInstalled))
		for _, s := range result.Plugins.ForceInstalled {
			existing[s] = true
		}
		for _, s := range enterprise.PluginForceInstalled {
			if !existing[s] {
				result.Plugins.ForceInstalled = append(result.Plugins.ForceInstalled, s)
			}
		}
	}
	if len(enterprise.PluginAllowlist) > 0 {
		// Sealed ceiling: enterprise allowlist replaces user allowlist entirely.
		if result.Plugins == nil {
			result.Plugins = &types.PluginsConfig{}
		}
		result.Plugins.Allowlist = enterprise.PluginAllowlist
		utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise sealed plugin allowlist", map[string]any{
			"count": len(enterprise.PluginAllowlist),
		})
	}
	if len(enterprise.PluginDenylist) > 0 {
		// Additive: enterprise denylist is unioned with the user denylist.
		if result.Plugins == nil {
			result.Plugins = &types.PluginsConfig{}
		}
		existing := make(map[string]bool, len(result.Plugins.Denylist))
		for _, s := range result.Plugins.Denylist {
			existing[s] = true
		}
		for _, s := range enterprise.PluginDenylist {
			if !existing[s] {
				result.Plugins.Denylist = append(result.Plugins.Denylist, s)
			}
		}
	}

	// Telemetry: if enterprise requires enabled, it cannot be disabled below
	if enterprise.Telemetry != nil && enterprise.Telemetry.Enabled {
		if result.Telemetry == nil {
			result.Telemetry = &types.TelemetryConfig{}
		}
		result.Telemetry.Enabled = true
		if len(enterprise.Telemetry.Targets) > 0 {
			result.Telemetry.Targets = enterprise.Telemetry.Targets
		}
		if enterprise.Telemetry.PrivacyLevel != "" {
			result.Telemetry.PrivacyLevel = enterprise.Telemetry.PrivacyLevel
		}
		// The destination of each sealed target. Without these an enterprise
		// could force the "http" or "eventhub" target on but supply nowhere to
		// send, so every flush would fail into the retry queue: a sealed
		// policy that cannot deliver. Same set as the ConversationEvents seal
		// below.
		if enterprise.Telemetry.HttpEndpoint != "" {
			result.Telemetry.HttpEndpoint = enterprise.Telemetry.HttpEndpoint
		}
		if len(enterprise.Telemetry.HttpHeaders) > 0 {
			result.Telemetry.HttpHeaders = enterprise.Telemetry.HttpHeaders
		}
		if enterprise.Telemetry.EventHubNamespace != "" {
			result.Telemetry.EventHubNamespace = enterprise.Telemetry.EventHubNamespace
		}
		if enterprise.Telemetry.EventHubName != "" {
			result.Telemetry.EventHubName = enterprise.Telemetry.EventHubName
		}
		if enterprise.Telemetry.EventHubTokenScope != "" {
			result.Telemetry.EventHubTokenScope = enterprise.Telemetry.EventHubTokenScope
		}
		if enterprise.Telemetry.EventHubTokenAudience != "" {
			result.Telemetry.EventHubTokenAudience = enterprise.Telemetry.EventHubTokenAudience
		}
		if enterprise.Telemetry.EventHubConnectionString != "" {
			result.Telemetry.EventHubConnectionString = enterprise.Telemetry.EventHubConnectionString
		}
		if enterprise.Telemetry.OversizeEventPolicy != "" {
			result.Telemetry.OversizeEventPolicy = enterprise.Telemetry.OversizeEventPolicy
		}
		// OpenTelemetry export, including the metrics block. Without this an
		// enterprise that seals telemetry on could not also seal where its
		// OTLP traces and metrics go.
		if enterprise.Telemetry.Otel != nil {
			result.Telemetry.Otel = enterprise.Telemetry.Otel
		}
	}

	// SystemMetrics: an enterprise block replaces the user's whole. It can
	// fix the sampling cadence and telemetry interval, or turn sampling off.
	if enterprise.SystemMetrics != nil {
		sealed := *enterprise.SystemMetrics
		result.SystemMetrics = &sealed
	}

	// ConversationEvents: same one-way seal pattern as Telemetry above,
	// applied to the fully independent conversation.* config block (issue
	// #378). This is a separate seal from Telemetry's — an enterprise can
	// force conversation events on without ever enabling general telemetry,
	// and vice versa, matching the standalone-collector decision.
	if enterprise.ConversationEvents != nil && enterprise.ConversationEvents.Enabled {
		if result.ConversationEvents == nil {
			result.ConversationEvents = &types.ConversationEventsConfig{}
		}
		result.ConversationEvents.Enabled = true
		if len(enterprise.ConversationEvents.Targets) > 0 {
			result.ConversationEvents.Targets = enterprise.ConversationEvents.Targets
		}
		if enterprise.ConversationEvents.HttpEndpoint != "" {
			result.ConversationEvents.HttpEndpoint = enterprise.ConversationEvents.HttpEndpoint
		}
		if enterprise.ConversationEvents.Otel != nil {
			result.ConversationEvents.Otel = enterprise.ConversationEvents.Otel
		}
		// Event Hub destination. Without these an enterprise could force the
		// "eventhub" target on but supply nowhere to send, so every flush
		// would fail into the retry queue — a sealed policy that cannot
		// actually deliver.
		//
		// The namespace/scope fields carry no secret, which is what makes
		// them safe to distribute through an MDM channel that lands on every
		// managed device: the device authenticates with its own identity and
		// authorization is an RBAC assignment. The connection string is
		// forwarded too, because an operator may have a deployment that needs
		// it, but doing so puts one shared secret on every device in the
		// fleet — see types.TelemetryConfig.EventHubNamespace.
		if enterprise.ConversationEvents.EventHubNamespace != "" {
			result.ConversationEvents.EventHubNamespace = enterprise.ConversationEvents.EventHubNamespace
		}
		if enterprise.ConversationEvents.EventHubName != "" {
			result.ConversationEvents.EventHubName = enterprise.ConversationEvents.EventHubName
		}
		if enterprise.ConversationEvents.EventHubTokenScope != "" {
			result.ConversationEvents.EventHubTokenScope = enterprise.ConversationEvents.EventHubTokenScope
		}
		if enterprise.ConversationEvents.EventHubTokenAudience != "" {
			result.ConversationEvents.EventHubTokenAudience = enterprise.ConversationEvents.EventHubTokenAudience
		}
		if enterprise.ConversationEvents.EventHubConnectionString != "" {
			result.ConversationEvents.EventHubConnectionString = enterprise.ConversationEvents.EventHubConnectionString
		}
		// The oversize policy is a fidelity decision — segment keeps every
		// byte in the stream, quarantine keeps it only on the device — so an
		// enterprise that seals the stream gets to seal that choice too.
		if enterprise.ConversationEvents.OversizeEventPolicy != "" {
			result.ConversationEvents.OversizeEventPolicy = enterprise.ConversationEvents.OversizeEventPolicy
		}
	}

	// Logging egress: if enterprise forces egress targets on, users cannot
	// disable them. Only egress fields are enforced; local-file settings
	// (Format, MaxSizeMB, OutputMode, LogDir) are not overridden here.
	if enterprise.Logging != nil && len(enterprise.Logging.EgressTargets) > 0 {
		if result.Logging == nil {
			result.Logging = &types.LoggingConfig{}
		}
		result.Logging.EgressTargets = enterprise.Logging.EgressTargets
		if enterprise.Logging.EgressEndpoint != "" {
			result.Logging.EgressEndpoint = enterprise.Logging.EgressEndpoint
		}
		if len(enterprise.Logging.EgressHeaders) > 0 {
			result.Logging.EgressHeaders = enterprise.Logging.EgressHeaders
		}
		if enterprise.Logging.EgressBatchSize > 0 {
			result.Logging.EgressBatchSize = enterprise.Logging.EgressBatchSize
		}
		if enterprise.Logging.EgressFlushIntervalMs > 0 {
			result.Logging.EgressFlushIntervalMs = enterprise.Logging.EgressFlushIntervalMs
		}
		if enterprise.Logging.EgressOtel != nil {
			result.Logging.EgressOtel = enterprise.Logging.EgressOtel
		}
		// Preserve the user/lower-layer delegation flag. Enterprise sealing forces
		// egress ON (targets, endpoint, auth) but does NOT decide WHO ships: on a
		// managed workstation the desktop tails engine.jsonl and ships under its
		// OIDC token, so the engine's own forwarder must stay suppressed to avoid
		// double-shipping. The desktop sets egressManagedByClient on the engine.json
		// it manages; enterprise enforcement here must not clobber it back to false.
		if enterprise.Logging.EgressManagedByClient {
			result.Logging.EgressManagedByClient = true
		}
		// Shipping-responsibility matrix: enterprise MAY seal it (deciding
		// which sources the engine ships), but when the enterprise config is
		// silent the lower layer's explicit assignment stands — the same
		// don't-clobber principle as the delegation flag above.
		if enterprise.Logging.EgressShipSources != nil {
			result.Logging.EgressShipSources = enterprise.Logging.EgressShipSources
		}
		if enterprise.Logging.EgressClientShipSources != nil {
			result.Logging.EgressClientShipSources = enterprise.Logging.EgressClientShipSources
		}
		// Authenticated egress: enterprise can force the token scope and
		// audience used to authenticate each flush.
		if enterprise.Logging.EgressTokenScope != "" {
			result.Logging.EgressTokenScope = enterprise.Logging.EgressTokenScope
		}
		if enterprise.Logging.EgressTokenAudience != "" {
			result.Logging.EgressTokenAudience = enterprise.Logging.EgressTokenAudience
		}
		// And the credential that mints it (an auth.oauth entry name).
		if enterprise.Logging.EgressTokenProvider != "" {
			result.Logging.EgressTokenProvider = enterprise.Logging.EgressTokenProvider
		}
		utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise forcing log egress", map[string]any{"status": enterprise.Logging.EgressTargets, "path": enterprise.Logging.EgressEndpoint})
	}

	// Network: enterprise proxy/CA enforcement
	if enterprise.Network != nil {
		if result.Network == nil {
			result.Network = &types.NetworkConfig{}
		}
		if enterprise.Network.Proxy != nil {
			result.Network.Proxy = enterprise.Network.Proxy
		}
		if len(enterprise.Network.CustomCaCerts) > 0 {
			result.Network.CustomCaCerts = enterprise.Network.CustomCaCerts
		}
	}

	// Resource limits: sealed ceiling (D-007). The enterprise value caps the
	// user value — a user/project config may set a LOWER limit than the
	// enterprise allows but can never exceed it, and an absent user value
	// takes the enterprise value directly. Mirrors the AllowedModels pattern:
	// enforcement lowers, never raises.
	if enterprise.ResourceLimits != nil {
		if result.ResourceLimits == nil {
			result.ResourceLimits = &types.ResourceLimits{}
		} else {
			// Copy-on-write so the ceiling clamp below doesn't mutate the
			// caller's config (same discipline as the McpServers deep copy).
			dup := *result.ResourceLimits
			result.ResourceLimits = &dup
		}
		result.ResourceLimits.MaxSessions = sealLimitCeiling(result.ResourceLimits.MaxSessions, enterprise.ResourceLimits.MaxSessions, "maxSessions")
		result.ResourceLimits.MaxAgentsPerSession = sealLimitCeiling(result.ResourceLimits.MaxAgentsPerSession, enterprise.ResourceLimits.MaxAgentsPerSession, "maxAgentsPerSession")
	}

	// Principal partitioning (FR-01): two independent one-way seals.
	// RequirePrincipalPartitioning forces Enabled=true regardless of the
	// lower layer's own setting; MinEnforcement raises Enforcement to at
	// least the enterprise floor. Neither can be softened by a lower layer.
	if enterprise.Security != nil && (enterprise.Security.RequirePrincipalPartitioning || enterprise.Security.MinEnforcement != "") {
		if result.Security == nil {
			result.Security = &types.SecurityConfig{}
		} else {
			dup := *result.Security
			result.Security = &dup
		}
		existing := result.Security.PrincipalPartitioning
		enabled := existing != nil && existing.Enabled
		// Left empty (not EnforcementNone) when nothing was explicitly
		// configured, so an untouched value still gets ResolvedEnforcement's
		// own "enabled with no explicit level -> strict" default rather than
		// this seal silently pinning it to "none".
		var enforcement types.PrincipalEnforcement
		if existing != nil {
			enforcement = existing.Enforcement
		}
		if enterprise.Security.RequirePrincipalPartitioning && !enabled {
			enabled = true
			utils.LogWithFields(utils.LevelInfo, "ConfigMerge", "enterprise: principal partitioning required; enabling", nil)
		}
		if enterprise.Security.MinEnforcement != "" {
			sealed := types.SealMinEnforcement(enforcement, enterprise.Security.MinEnforcement)
			if sealed != enforcement {
				utils.LogWithFields(utils.LevelInfo, "ConfigMerge", "enterprise: principal enforcement raised to the sealed minimum", map[string]any{
					"configured": string(enforcement), "sealed": string(sealed),
				})
			}
			enforcement = sealed
		}
		result.Security.PrincipalPartitioning = &types.PrincipalPartitioningConfig{Enabled: enabled, Enforcement: enforcement}
	}

	// Git identity (FR-04): Required is a one-way seal (mirrors
	// RequirePrincipalPartitioning above); Machine, when the enterprise sets
	// one, replaces the user-layer fallback identity wholesale.
	if enterprise.Git != nil && (enterprise.Git.Required || enterprise.Git.Machine != nil) {
		var existing types.GitIdentityConfig
		if result.Git != nil {
			existing = result.Git.Identity
		}
		if enterprise.Git.Required && !existing.RequiredEnabled() {
			required := true
			existing.Required = &required
			utils.LogWithFields(utils.LevelInfo, "ConfigMerge", "enterprise: git identity required; enabling", nil)
		}
		if enterprise.Git.Machine != nil {
			existing.Machine = enterprise.Git.Machine
		}
		result.Git = &types.GitConfig{Identity: existing}
	}

	// Plan-mode Bash allowlist: sealed ceiling. The merged user+project union
	// is intersected against the enterprise set, so a project .ion/engine.json
	// committed into a repo cannot widen plan-mode Bash on a managed machine.
	// Nil enterprise value means no policy on this axis and the union stands.
	if enterprise.Limits != nil && enterprise.Limits.PlanModeAllowedBashCommands != nil {
		result.Limits.PlanModeAllowedBashCommands = intersectBashCommandsWithCeiling(
			result.Limits.PlanModeAllowedBashCommands,
			enterprise.Limits.PlanModeAllowedBashCommands,
		)
	}
	if enterprise.Limits != nil && enterprise.Limits.PlanModeAllowedMcpTools != nil {
		result.Limits.PlanModeAllowedMcpTools = intersectMcpToolsWithCeiling(
			result.Limits.PlanModeAllowedMcpTools,
			enterprise.Limits.PlanModeAllowedMcpTools,
		)
	}

	// Extended thinking: sealed ceiling, one way only. An enterprise
	// Disabled=true forces thinking off and no lower layer can re-enable it.
	// An enterprise block with Disabled=false is NOT a mandate to think — it
	// leaves the merged user/project value alone, so an operator who disabled
	// thinking locally keeps that choice. Copy-on-write so the clamp never
	// mutates the caller's block (same discipline as ResourceLimits above).
	// Both branches logged: a capability change that happens silently is
	// undiagnosable from the log file alone.
	if enterprise.Thinking != nil && enterprise.Thinking.Disabled {
		already := result.ThinkingPolicy != nil && result.ThinkingPolicy.Disabled
		result.ThinkingPolicy = &types.ThinkingPolicyConfig{Disabled: true}
		utils.LogWithFields(utils.LevelInfo, "ConfigMerge", "enterprise: extended thinking sealed off", map[string]any{
			"status": false, "changed": !already,
		})
	} else if enterprise.Thinking != nil {
		utils.LogWithFields(utils.LevelInfo, "ConfigMerge", "enterprise: thinking policy present but not disabling, merged value stands", map[string]any{
			"status": result.ThinkingPolicy == nil || !result.ThinkingPolicy.Disabled,
		})
	}

	// Enterprise new-conversation defaults are a sealed policy block. A
	// non-nil enterprise block replaces the global/project default before any
	// session resolves it; ProfileLocked is then enforced at start_session.
	if enterprise.NewConversationDefaults != nil {
		copy := *enterprise.NewConversationDefaults
		result.NewConversationDefaults = &copy
	}

	// Store enterprise config for runtime access
	result.Enterprise = enterprise

	return &result
}

// mcpServerURLHost extracts the hostname from an MCP server's configured URL.
// Returns "" for stdio servers (no URL) and for URLs that fail to parse —
// callers treat "" as "no host to match", falling back to name-only checks.
func mcpServerURLHost(server types.McpServerConfig) string {
	if server.URL == "" {
		return ""
	}
	u, err := url.Parse(server.URL)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "config.merge", "MCP server URL unparseable for host allowlist match", map[string]any{"url": server.URL, "error": err.Error()})
		return ""
	}
	return u.Hostname()
}

// IsModelAllowed checks if a model is permitted by enterprise policy.
func IsModelAllowed(model string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil {
		return true
	}
	if contains(enterprise.BlockedModels, model) {
		return false
	}
	if len(enterprise.AllowedModels) > 0 && !contains(enterprise.AllowedModels, model) {
		return false
	}
	return true
}

// IsToolAllowed checks if a tool is permitted by enterprise policy.
func IsToolAllowed(toolName string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil || enterprise.ToolRestrictions == nil {
		return true
	}
	if contains(enterprise.ToolRestrictions.Deny, toolName) {
		return false
	}
	if len(enterprise.ToolRestrictions.Allow) > 0 && !contains(enterprise.ToolRestrictions.Allow, toolName) {
		return false
	}
	return true
}

// principalMatches reports whether principal satisfies match. A nil
// principal (unattributed session) matches only a rule with every field
// empty -- there is no subject/provider/claim to compare against.
func principalMatches(principal *types.SessionPrincipal, match types.PrincipalMatch) bool {
	if principal == nil {
		return len(match.Subjects) == 0 && len(match.Providers) == 0 && len(match.Claims) == 0
	}
	if len(match.Subjects) > 0 && !contains(match.Subjects, principal.Subject) {
		return false
	}
	if len(match.Providers) > 0 && !contains(match.Providers, principal.Provider) {
		return false
	}
	for claimKey, allowedValues := range match.Claims {
		if !principalHasClaim(principal, claimKey, allowedValues) {
			return false
		}
	}
	return true
}

// principalHasClaim reports whether principal.Claims[claimKey] contains at
// least one of allowedValues. A claim value may be a bare string (a single
// role/tenant) or a []any of strings (a roles list, the common JWT shape
// after JSON decode) -- both are checked.
func principalHasClaim(principal *types.SessionPrincipal, claimKey string, allowedValues []string) bool {
	if principal.Claims == nil {
		return false
	}
	raw, ok := principal.Claims[claimKey]
	if !ok {
		return false
	}
	switch v := raw.(type) {
	case string:
		return contains(allowedValues, v)
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && contains(allowedValues, s) {
				return true
			}
		}
	case []string:
		for _, s := range v {
			if contains(allowedValues, s) {
				return true
			}
		}
	}
	return false
}

// IsToolAllowedFor is FR-03's per-principal tool-policy check: IsToolAllowed's
// global Allow/Deny first (an enterprise-wide deny always wins, even over a
// principal-specific allow), then every ToolRestrictions.Principals rule
// matching principal. Deny wins across matching rules; when at least one
// matching rule declares a non-empty Allow, toolName must be in the
// INTERSECTION of every matching rule's Allow list (each matching rule's
// allowlist independently narrows what's permitted -- one rule's silence on
// Allow does not widen another's).
func IsToolAllowedFor(toolName string, principal *types.SessionPrincipal, enterprise *types.EnterpriseConfig) bool {
	if !IsToolAllowed(toolName, enterprise) {
		return false
	}
	if enterprise == nil || enterprise.ToolRestrictions == nil || len(enterprise.ToolRestrictions.Principals) == 0 {
		return true
	}
	for _, rule := range enterprise.ToolRestrictions.Principals {
		if !principalMatches(principal, rule.Match) {
			continue
		}
		if contains(rule.Deny, toolName) {
			return false
		}
		if len(rule.Allow) > 0 && !contains(rule.Allow, toolName) {
			return false
		}
	}
	// No matching rule (or every matching rule silent on both lists) ->
	// global policy alone governs, already checked above.
	return true
}

// ToolBlockReason classifies WHY IsToolAllowedFor(toolName, principal,
// enterprise) would refuse toolName, for audit telemetry
// (EnforcementToolBlocked). Only meaningful to call when the tool is in
// fact blocked; returns ("", "") for an allowed tool. source is "denylist"
// (global deny), "allowlist" (excluded from a global allowlist), or
// "principal" (a per-principal rule); rule names the matched principal
// rule's subject/provider match for a "principal" source, empty otherwise.
func ToolBlockReason(toolName string, principal *types.SessionPrincipal, enterprise *types.EnterpriseConfig) (source, rule string) {
	if enterprise == nil {
		return "", ""
	}
	if enterprise.ToolRestrictions != nil {
		if contains(enterprise.ToolRestrictions.Deny, toolName) {
			return "denylist", ""
		}
		if len(enterprise.ToolRestrictions.Allow) > 0 && !contains(enterprise.ToolRestrictions.Allow, toolName) {
			return "allowlist", ""
		}
		for _, r := range enterprise.ToolRestrictions.Principals {
			if !principalMatches(principal, r.Match) {
				continue
			}
			if contains(r.Deny, toolName) {
				return "principal", strings.Join(r.Match.Subjects, ",")
			}
			if len(r.Allow) > 0 && !contains(r.Allow, toolName) {
				return "principal", strings.Join(r.Match.Subjects, ",")
			}
		}
	}
	return "", ""
}

// IsMcpAllowed checks if an MCP server is permitted by enterprise policy.
func IsMcpAllowed(serverName string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil {
		return true
	}
	if contains(enterprise.McpDenylist, serverName) {
		return false
	}
	if len(enterprise.McpAllowlist) > 0 && !contains(enterprise.McpAllowlist, serverName) {
		return false
	}
	return true
}

// IsPluginAllowed reports whether a plugin source is permitted by enterprise policy.
// Glob patterns are supported (e.g. "JuliusBrussee/*" matches "JuliusBrussee/caveman").
// When enterprise is nil, all sources are allowed.
func IsPluginAllowed(source string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil {
		return true
	}
	if IsPluginDenied(source, enterprise) {
		return false
	}
	if len(enterprise.PluginAllowlist) > 0 && !matchesAny(enterprise.PluginAllowlist, source) {
		return false
	}
	return true
}

// IsPluginDenied reports whether a plugin source is blocked by enterprise policy.
// Glob patterns are supported. When enterprise is nil, nothing is denied.
func IsPluginDenied(source string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil {
		return false
	}
	return matchesAny(enterprise.PluginDenylist, source)
}

// matchesAny returns true when any pattern in patterns glob-matches target.
// Uses path.Match semantics: "JuliusBrussee/*" matches "JuliusBrussee/caveman".
func matchesAny(patterns []string, target string) bool {
	for _, p := range patterns {
		if ok, _ := path.Match(p, target); ok { //nolint:errcheck // bad pattern -> no match, which is correct
			return true
		}
		// Also try exact match for plain strings without wildcards.
		if p == target {
			return true
		}
	}
	return false
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
