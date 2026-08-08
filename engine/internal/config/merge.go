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

	// Store enterprise config for runtime access
	result.Enterprise = enterprise

	return &result
}

// intersectBashCommandsWithCeiling clamps a merged plan-mode Bash allowlist to
// an enterprise ceiling, returning only the entries the ceiling sanctions.
//
// An empty (non-nil) ceiling is the "no Bash in plan mode" policy and strips
// everything. Otherwise an entry is retained when it is exactly a ceiling
// entry, or when it is a MORE SPECIFIC form of one — ceiling "gh" retains
// "gh pr view", because the gate's prefix matching already lets every "gh ..."
// command through when "gh" is permitted, so keeping the narrower entry grants
// nothing new.
//
// The asymmetry is the whole security property, and it runs one way only:
// a lower layer can never generalise a ceiling entry outward. With ceiling
// "gh pr view", a project asking for "gh" is dropped, not kept — retaining it
// would permit "gh repo delete", which the ceiling deliberately excluded.
// Every dropped entry is recorded as an enforcement action so the operator can
// see which project/user entries policy rejected.
func intersectBashCommandsWithCeiling(merged, ceiling []string) []string {
	if len(ceiling) == 0 {
		// Explicit block-all policy. Record each stripped entry.
		for _, cmd := range merged {
			recordEnforcement(EnforcementPlanModeBashPruned, cmd, "planModeAllowedBashCommands", map[string]any{
				"reason": "enterprise policy blocks Bash in plan mode",
			})
		}
		return []string{}
	}
	out := make([]string, 0, len(merged))
	for _, cmd := range merged {
		if bashCommandWithinCeiling(cmd, ceiling) {
			out = append(out, cmd)
			continue
		}
		recordEnforcement(EnforcementPlanModeBashPruned, cmd, "planModeAllowedBashCommands", map[string]any{
			"reason": "not permitted by enterprise plan-mode Bash ceiling",
		})
	}
	return out
}

// bashCommandWithinCeiling reports whether cmd is permitted by the ceiling:
// an exact match, or an extension of a ceiling entry at a word boundary.
//
// The word-boundary check prevents a prefix-string coincidence from passing as
// a policy match: ceiling "git" must not sanction "github-cli-doer" merely
// because the bytes line up. Requiring the next character to be a space means
// only genuine sub-commands ("git log") are treated as narrower forms.
func bashCommandWithinCeiling(cmd string, ceiling []string) bool {
	for _, allowed := range ceiling {
		if cmd == allowed {
			return true
		}
		if strings.HasPrefix(cmd, allowed+" ") {
			return true
		}
	}
	return false
}

// sealLimitCeiling resolves one resource-limit field against the enterprise
// ceiling. A nil enterprise value leaves the user value untouched (no policy
// on this axis). A non-nil enterprise value caps the result: an absent or
// higher user value is replaced by the ceiling; a lower user value stands
// (users may self-restrict below policy, never exceed it).
func sealLimitCeiling(user, enterprise *int, name string) *int {
	if enterprise == nil {
		return user
	}
	if user == nil || *user > *enterprise {
		if user != nil {
			utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: resource limit capped to ceiling", map[string]any{"limit": name, "user": *user, "ceiling": *enterprise})
		}
		v := *enterprise
		return &v
	}
	return user
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
	if src.Limits.SuppressSystemMessages != nil {
		dst.Limits.SuppressSystemMessages = src.Limits.SuppressSystemMessages
	}
	if src.Limits.DisablePlanModeReminder != nil {
		dst.Limits.DisablePlanModeReminder = src.Limits.DisablePlanModeReminder
	}
	if src.Limits.DisableTurnLimitWarning != nil {
		dst.Limits.DisableTurnLimitWarning = src.Limits.DisableTurnLimitWarning
	}
	if src.Limits.DisableMaxTokenContinue != nil {
		dst.Limits.DisableMaxTokenContinue = src.Limits.DisableMaxTokenContinue
	}
	// PlanModeAllowedBashCommands is a slice, not a pointer, and carries a
	// tri-valued contract across layers:
	//
	//   nil        — this layer did not set the field; the earlier layer stands.
	//   non-empty  — ADDITIVE. Unioned with the earlier layer's list, so a
	//                project .ion/engine.json can permit a command the user's
	//                global config never mentioned (and vice versa) without
	//                either layer having to restate the other's entries.
	//   empty ([]) — an intentional "block Bash entirely in plan mode" signal.
	//                It wins over any earlier non-empty list, matching normal
	//                layer precedence: the later, more specific layer decides.
	//
	// Additive-union (rather than whole-slice replacement) is what makes the
	// project layer portable: a repo that needs one extra command ships it in
	// .ion/engine.json and every clone gains it on top of whatever each
	// developer already allows globally. Replacement would force the project
	// file to restate every developer's personal list, which it cannot know.
	//
	// This union is deliberately NOT a security boundary. When an enterprise
	// policy exists, EnforceEnterprise intersects the merged result against
	// the enterprise ceiling AFTER this merge runs, so no combination of user
	// and project entries can widen past what the enterprise permits. Absent
	// an enterprise policy there is no policy to circumvent — an unmanaged
	// machine configuring its own tool is the point of the project layer.
	if src.Limits.PlanModeAllowedBashCommands != nil {
		if len(src.Limits.PlanModeAllowedBashCommands) == 0 {
			// Explicit block-all from the higher-precedence layer.
			dst.Limits.PlanModeAllowedBashCommands = []string{}
		} else {
			dst.Limits.PlanModeAllowedBashCommands = unionBashCommands(
				dst.Limits.PlanModeAllowedBashCommands,
				src.Limits.PlanModeAllowedBashCommands,
			)
		}
	}
	// MaxTokenThinkingOnlyBreaker is a non-pointer int: zero means "not set /
	// use the built-in default", so only a non-zero value from a later layer
	// overrides. -1 (disable the breaker) is a legitimate non-zero override.
	if src.Limits.MaxTokenThinkingOnlyBreaker != 0 {
		dst.Limits.MaxTokenThinkingOnlyBreaker = src.Limits.MaxTokenThinkingOnlyBreaker
	}
	if src.Limits.PlanModeAutoExitOnEndTurn != nil {
		dst.Limits.PlanModeAutoExitOnEndTurn = src.Limits.PlanModeAutoExitOnEndTurn
	}
	if src.Limits.DisableSkillSystemPrompt != nil {
		dst.Limits.DisableSkillSystemPrompt = src.Limits.DisableSkillSystemPrompt
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

	// Plugins: whole-block override (pointer). A later layer that sets the block
	// replaces an earlier one; nil leaves the earlier value intact. Same convention
	// as Permissions / Network / Telemetry.
	if src.Plugins != nil {
		dst.Plugins = src.Plugins
	}

	// ResourceLimits: whole-block override (pointer), same convention as
	// Plugins above. Enterprise ceiling enforcement happens later in
	// EnforceEnterprise; this merge only carries the user/project layers.
	if src.ResourceLimits != nil {
		dst.ResourceLimits = src.ResourceLimits
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

	// Shell: override the whole pointer if set. The engine.json shell block
	// (useLoginShell / shellPath) is small and atomic, so whole-pointer
	// replacement matches the Permissions/Network/Telemetry convention above
	// and avoids a field-by-field merge that would add no value.
	if src.Shell != nil {
		dst.Shell = src.Shell
	}

	// Optional pointer blocks that are consumed from the merged config by
	// downstream layers (cmd_serve, the session layer, prompt options) but
	// were historically not carried through this merge. Each is overridden
	// as a whole pointer when the source layer sets it, matching the
	// Permissions/Network/Telemetry convention. Without these, a user who
	// sets the block in ~/.ion/engine.json or a project .ion/engine.json
	// has it silently dropped. See TestMergeCarriesOptionalPointerBlocks.
	if src.Security != nil {
		dst.Security = src.Security
	}
	if src.FeatureFlags != nil {
		dst.FeatureFlags = src.FeatureFlags
	}
	if src.Relay != nil {
		dst.Relay = src.Relay
	}
	if src.WebSearch != nil {
		dst.WebSearch = src.WebSearch
	}
	if src.Webhooks != nil {
		dst.Webhooks = src.Webhooks
	}
	if src.Scheduling != nil {
		dst.Scheduling = src.Scheduling
	}

	// LogLevel: project-level overrides global
	if src.LogLevel != "" {
		dst.LogLevel = src.LogLevel
	}

	// Logging: whole-block override (pointer). A later layer that sets the
	// block replaces an earlier one; nil leaves the earlier value intact.
	if src.Logging != nil {
		dst.Logging = src.Logging
	}

	// EarlyStopContinue: merge field-by-field so engine.json can override a
	// single sub-field (e.g. just `enabled`) without nuking the others.
	// Built-in defaults are applied later at the run-loop layer; merge here
	// only carries forward explicit values from JSON layers.
	if src.EarlyStopContinue != nil {
		if dst.EarlyStopContinue == nil {
			cp := *src.EarlyStopContinue
			dst.EarlyStopContinue = &cp
		} else {
			if src.EarlyStopContinue.Enabled != nil {
				dst.EarlyStopContinue.Enabled = src.EarlyStopContinue.Enabled
			}
			if src.EarlyStopContinue.Budget != 0 {
				dst.EarlyStopContinue.Budget = src.EarlyStopContinue.Budget
			}
			if src.EarlyStopContinue.ThresholdPct != 0 {
				dst.EarlyStopContinue.ThresholdPct = src.EarlyStopContinue.ThresholdPct
			}
			if src.EarlyStopContinue.MaxContinuations != 0 {
				dst.EarlyStopContinue.MaxContinuations = src.EarlyStopContinue.MaxContinuations
			}
			if src.EarlyStopContinue.DiminishingDelta != 0 {
				dst.EarlyStopContinue.DiminishingDelta = src.EarlyStopContinue.DiminishingDelta
			}
		}
	}

	// Thinking: merge field-by-field so a layer can override a single
	// sub-field (e.g. just `effort`) without nuking the others. Mirrors the
	// EarlyStopContinue treatment above.
	//
	// Enabled is a plain bool, so it cannot distinguish "absent" from
	// "explicitly false" the way the pointer-bools can. It is therefore
	// carried whenever the source declares the block at all — a layer that
	// writes `"thinking": {"enabled": false}` is expressing intent to
	// disable, and that must beat a weaker layer that enabled it.
	// StreamDeltas and Persist are pointer-bools and carry only when set.
	if src.Thinking != nil {
		if dst.Thinking == nil {
			cp := *src.Thinking
			dst.Thinking = &cp
		} else {
			dst.Thinking.Enabled = src.Thinking.Enabled
			if src.Thinking.Effort != "" {
				dst.Thinking.Effort = src.Thinking.Effort
			}
			if src.Thinking.BudgetTokens != 0 {
				dst.Thinking.BudgetTokens = src.Thinking.BudgetTokens
			}
			if src.Thinking.StreamDeltas != nil {
				dst.Thinking.StreamDeltas = src.Thinking.StreamDeltas
			}
			if src.Thinking.Persist != nil {
				dst.Thinking.Persist = src.Thinking.Persist
			}
		}
	}

	// Timeouts: merge non-zero fields
	if src.Timeouts != nil {
		dst.Timeouts = types.MergeTimeouts(dst.Timeouts, src.Timeouts)
	}

	// Workspace: merge non-zero fields (reap grace window, watcher dir cap)
	if src.Workspace != nil {
		dst.Workspace = types.MergeWorkspace(dst.Workspace, src.Workspace)
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

// unionBashCommands merges two plan-mode Bash allowlists, preserving order and
// dropping duplicates. Entries from base come first (the lower-precedence
// layer), then any entry from add that base did not already contain.
//
// Order is stable rather than sorted so the resolved list reads the way the
// operator wrote it: their global entries, then whatever the project added.
// The gate that consumes this list does prefix matching, and prefix matching
// is order-independent, so ordering is a readability property (log lines,
// system-prompt prose) rather than a semantic one.
//
// Duplicate collapsing matters because both layers legitimately name common
// commands (git log, ls). Without it the resolved list, which is echoed into
// the plan-mode system prompt, would repeat entries back to the model.
func unionBashCommands(base, add []string) []string {
	seen := make(map[string]struct{}, len(base)+len(add))
	out := make([]string, 0, len(base)+len(add))
	for _, list := range [][]string{base, add} {
		for _, cmd := range list {
			if cmd == "" {
				continue
			}
			if _, dup := seen[cmd]; dup {
				continue
			}
			seen[cmd] = struct{}{}
			out = append(out, cmd)
		}
	}
	return out
}
