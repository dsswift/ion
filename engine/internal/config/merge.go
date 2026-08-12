package config

import (
	"net/url"
	"path"

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

	// Blocked models: if defaultModel is blocked, fall back
	if contains(enterprise.BlockedModels, result.DefaultModel) {
		fallback := "claude-sonnet-4-6"
		if len(enterprise.AllowedModels) > 0 {
			fallback = enterprise.AllowedModels[0]
		}
		utils.Log("ConfigMerge", "enterprise: defaultModel \""+result.DefaultModel+"\" is blocked, falling back to \""+fallback+"\"")
		result.DefaultModel = fallback
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
				utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: MCP server allowed by URL host pattern", map[string]any{"server": key, "host": host})
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
		// Authenticated egress: enterprise can force the operator-token scope
		// used to authenticate each flush.
		if enterprise.Logging.EgressTokenScope != "" {
			result.Logging.EgressTokenScope = enterprise.Logging.EgressTokenScope
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
