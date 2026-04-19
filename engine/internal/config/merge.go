package config

import (
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

	// MCP server restrictions -- deny list
	if len(enterprise.McpDenylist) > 0 && result.McpServers != nil {
		for _, denied := range enterprise.McpDenylist {
			if _, ok := result.McpServers[denied]; ok {
				utils.Log("ConfigMerge", "enterprise: removing denied MCP server \""+denied+"\"")
				delete(result.McpServers, denied)
			}
		}
	}

	// MCP server restrictions -- allow list
	if len(enterprise.McpAllowlist) > 0 && result.McpServers != nil {
		for key := range result.McpServers {
			if !contains(enterprise.McpAllowlist, key) {
				utils.Log("ConfigMerge", "enterprise: removing non-allowlisted MCP server \""+key+"\"")
				delete(result.McpServers, key)
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

	// Store enterprise config for runtime access
	result.Enterprise = enterprise

	return &result
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

// mergeInto applies fields from src onto dst (dst is mutated).
func mergeInto(dst, src *types.EngineRuntimeConfig) {
	if src.Backend != "" {
		dst.Backend = src.Backend
	}
	if src.DefaultModel != "" {
		dst.DefaultModel = src.DefaultModel
	}

	// Providers: merge maps
	if len(src.Providers) > 0 {
		if dst.Providers == nil {
			dst.Providers = make(map[string]types.ProviderConfig)
		}
		for k, v := range src.Providers {
			dst.Providers[k] = v
		}
	}

	// Limits: override if explicitly set (nil means "not set")
	if src.Limits.MaxTurns != nil {
		dst.Limits.MaxTurns = src.Limits.MaxTurns
	}
	if src.Limits.MaxBudgetUsd != nil {
		dst.Limits.MaxBudgetUsd = src.Limits.MaxBudgetUsd
	}
	if src.Limits.IdleTimeoutMs != nil {
		dst.Limits.IdleTimeoutMs = src.Limits.IdleTimeoutMs
	}

	// MCP servers: merge maps
	if len(src.McpServers) > 0 {
		if dst.McpServers == nil {
			dst.McpServers = make(map[string]types.McpServerConfig)
		}
		for k, v := range src.McpServers {
			dst.McpServers[k] = v
		}
	}

	// Profiles: replace if provided
	if len(src.Profiles) > 0 {
		dst.Profiles = src.Profiles
	}

	// Optional fields: override if set
	if src.Permissions != nil {
		dst.Permissions = src.Permissions
	}
	if src.Auth != nil {
		dst.Auth = src.Auth
	}
	if src.Network != nil {
		dst.Network = src.Network
	}
	if src.Telemetry != nil {
		dst.Telemetry = src.Telemetry
	}
	if src.Compaction != nil {
		dst.Compaction = src.Compaction
	}
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
