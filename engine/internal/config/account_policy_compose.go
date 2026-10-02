package config

// account_policy_compose.go — how one account policy composes under the
// machine policy.
//
// The machine policy is the ceiling. Every field belongs to one of four
// classes, and the class decides the rule:
//
//   - Allowlists: the account list is cut down to the entries the machine
//     list already permits. An entry outside the machine list is ignored. An
//     account list with nothing inside the machine list is ignored whole and
//     the machine list stands. The plan-mode lists are the exception: there
//     an empty result is a real value and means "none".
//   - Deny lists and additive lists: union.
//   - One-way switches and bounds: the stricter value wins.
//   - Managed values (endpoints, defaults, identity): the account value wins
//     when present, because differing per account is their purpose. A
//     one-way switch inside such a block still keeps the stricter value.
//
// Nothing here mutates either input.

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// composeNote records one account-policy value the composer refused.
type composeNote struct {
	Policy string
	Field  string
	Value  string
	Reason string
}

type composer struct {
	policy string
	notes  *[]composeNote
}

func (c composer) ignore(field, value, reason string) {
	if c.notes == nil {
		return
	}
	*c.notes = append(*c.notes, composeNote{Policy: c.policy, Field: field, Value: value, Reason: reason})
}

const (
	reasonOutsideCeiling = "outside the machine allowlist"
	reasonDisjoint       = "no entry inside the machine allowlist; machine list stands"
	reasonWouldAllow     = "an account policy cannot grant"
)

// composeAccountPolicy returns machine narrowed by account. name labels the
// account policy in notes.
func composeAccountPolicy(machine, account *types.EnterpriseConfig, name string, notes *[]composeNote) *types.EnterpriseConfig {
	if account == nil {
		return machine
	}
	if machine == nil {
		machine = &types.EnterpriseConfig{}
	}
	c := composer{policy: name, notes: notes}
	out := *machine

	// Allowlists.
	out.AllowedModels = c.allowlist("allowedModels", machine.AllowedModels, account.AllowedModels, exactWithin)
	out.AllowedProviders = c.allowlist("allowedProviders", machine.AllowedProviders, account.AllowedProviders, exactWithin)
	out.McpAllowlist = c.allowlist("mcpAllowlist", machine.McpAllowlist, account.McpAllowlist, patternWithin)
	out.PluginAllowlist = c.allowlist("pluginAllowlist", machine.PluginAllowlist, account.PluginAllowlist, patternWithin)
	out.ExtensionAllowlist = c.extensionAllowlist(machine.ExtensionAllowlist, account.ExtensionAllowlist)

	// Deny lists and additive lists.
	out.BlockedModels = unionStrings(machine.BlockedModels, account.BlockedModels)
	out.McpDenylist = unionStrings(machine.McpDenylist, account.McpDenylist)
	out.PluginDenylist = unionStrings(machine.PluginDenylist, account.PluginDenylist)
	out.PluginForceInstalled = unionStrings(machine.PluginForceInstalled, account.PluginForceInstalled)
	out.RequiredHooks = unionHooks(machine.RequiredHooks, account.RequiredHooks)
	out.ProtectedOperations = c.protectedOperations(machine.ProtectedOperations, account.ProtectedOperations)

	out.ToolRestrictions = c.toolRestrictions(machine.ToolRestrictions, account.ToolRestrictions)
	out.Permissions = c.permissions(machine.Permissions, account.Permissions)
	out.Sandbox = composeSandbox(machine.Sandbox, account.Sandbox)
	out.Security = composeSecurity(machine.Security, account.Security)
	out.Limits = composeLimits(machine.Limits, account.Limits)
	out.ResourceLimits = composeResourceLimits(machine.ResourceLimits, account.ResourceLimits)
	out.ConversationRetentionDays = minIntPtr(machine.ConversationRetentionDays, account.ConversationRetentionDays)
	if account.Thinking != nil && account.Thinking.Disabled {
		out.Thinking = &types.ThinkingPolicyConfig{Disabled: true}
	}
	out.DisableTelemetryHealthNotifications = machine.DisableTelemetryHealthNotifications || account.DisableTelemetryHealthNotifications

	// Managed values.
	out.Providers = c.providers(machine, account.Providers)
	out.Auth = composeAuth(machine.Auth, account.Auth)
	out.Telemetry = composeTelemetry(machine.Telemetry, account.Telemetry)
	out.ConversationEvents = composeConversationEvents(machine.ConversationEvents, account.ConversationEvents)
	out.Git = composeGit(machine.Git, account.Git)
	out.NewConversationDefaults = composeNewConversationDefaults(machine.NewConversationDefaults, account.NewConversationDefaults)
	if account.SubscriptionLookup != nil {
		cp := *account.SubscriptionLookup
		out.SubscriptionLookup = &cp
	}
	if account.SystemMetrics != nil {
		cp := *account.SystemMetrics
		out.SystemMetrics = &cp
	}
	if account.ApplicationConfig != nil {
		cp := *account.ApplicationConfig
		out.ApplicationConfig = &cp
	}
	if account.Network != nil {
		network := types.NetworkConfig{}
		if machine.Network != nil {
			network = *machine.Network
		}
		if account.Network.Proxy != nil {
			network.Proxy = account.Network.Proxy
		}
		if len(account.Network.CustomCaCerts) > 0 {
			network.CustomCaCerts = account.Network.CustomCaCerts
		}
		out.Network = &network
	}
	if account.Logging != nil {
		cp := *account.Logging
		out.Logging = &cp
	}
	out.CustomFields = mergeCustomFields(machine.CustomFields, account.CustomFields)

	return &out
}

// within reports whether entry is permitted by ceiling.
type within func(entry string, ceiling []string) bool

func exactWithin(entry string, ceiling []string) bool { return contains(ceiling, entry) }

// patternWithin also accepts an entry a ceiling glob matches. An entry that
// is itself a glob passes only when the ceiling names it exactly, since a
// glob cannot be shown to be narrower than another glob.
func patternWithin(entry string, ceiling []string) bool {
	if contains(ceiling, entry) {
		return true
	}
	if strings.ContainsAny(entry, "*?[") {
		return false
	}
	return matchesAny(ceiling, entry)
}

func (c composer) allowlist(field string, machine, account []string, in within) []string {
	if len(account) == 0 {
		return machine
	}
	if len(machine) == 0 {
		return append([]string(nil), account...)
	}
	kept := make([]string, 0, len(account))
	for _, entry := range account {
		if in(entry, machine) {
			kept = append(kept, entry)
			continue
		}
		c.ignore(field, entry, reasonOutsideCeiling)
	}
	if len(kept) == 0 {
		c.ignore(field, strings.Join(account, ","), reasonDisjoint)
		return machine
	}
	return kept
}

// extensionAllowlist keeps the account entries whose id the machine list
// names. A machine hash pin stands; an account pin applies where the machine
// entry has none. An account pin that disagrees with a machine pin is
// outside the ceiling.
func (c composer) extensionAllowlist(machine, account []types.ExtensionAllowlistEntry) []types.ExtensionAllowlistEntry {
	if len(account) == 0 {
		return machine
	}
	if len(machine) == 0 {
		return append([]types.ExtensionAllowlistEntry(nil), account...)
	}
	byID := make(map[string]types.ExtensionAllowlistEntry, len(machine))
	for _, entry := range machine {
		byID[entry.ID] = entry
	}
	kept := make([]types.ExtensionAllowlistEntry, 0, len(account))
	for _, entry := range account {
		ceiling, ok := byID[entry.ID]
		if !ok || (ceiling.SHA256 != "" && entry.SHA256 != "" && !strings.EqualFold(ceiling.SHA256, entry.SHA256)) {
			c.ignore("extensionAllowlist", entry.ID, reasonOutsideCeiling)
			continue
		}
		if ceiling.SHA256 != "" {
			entry.SHA256 = ceiling.SHA256
		}
		kept = append(kept, entry)
	}
	if len(kept) == 0 {
		c.ignore("extensionAllowlist", fmt.Sprintf("%d entries", len(account)), reasonDisjoint)
		return machine
	}
	return kept
}

func (c composer) toolRestrictions(machine, account *types.ToolRestrictions) *types.ToolRestrictions {
	if account == nil {
		return machine
	}
	out := types.ToolRestrictions{}
	if machine != nil {
		out = *machine
	}
	out.Allow = c.allowlist("toolRestrictions.allow", out.Allow, account.Allow, exactWithin)
	out.Deny = unionStrings(out.Deny, account.Deny)
	if len(account.Principals) > 0 {
		principals := make([]types.PrincipalToolRule, 0, len(out.Principals)+len(account.Principals))
		principals = append(principals, out.Principals...)
		out.Principals = append(principals, account.Principals...)
	}
	return &out
}

// permissions composes two permission policies. Rules are first-match, so
// position decides what a rule can do: an account "deny" rule goes first and
// can only take away; an account "ask" rule goes last and applies only where
// no machine rule matched, and is dropped when the mode already denies by
// default; an account "allow" rule is dropped.
func (c composer) permissions(machine, account *types.PermissionPolicy) *types.PermissionPolicy {
	if account == nil {
		return machine
	}
	out := types.PermissionPolicy{}
	if machine != nil {
		out = *machine
	}
	out.Mode = stricterPermissionMode(out.Mode, account.Mode)
	out.DangerousPatterns = unionStrings(out.DangerousPatterns, account.DangerousPatterns)
	out.ReadOnlyPaths = unionStrings(out.ReadOnlyPaths, account.ReadOnlyPaths)

	var denyFirst, askLast []types.PermissionRule
	for _, rule := range account.Rules {
		switch {
		case rule.Decision == "deny":
			denyFirst = append(denyFirst, rule)
		case rule.Decision == "ask" && out.Mode != "deny":
			askLast = append(askLast, rule)
		default:
			c.ignore("permissions.rules", rule.Tool+":"+rule.Decision, reasonWouldAllow)
		}
	}
	if len(denyFirst)+len(askLast) > 0 {
		rules := make([]types.PermissionRule, 0, len(denyFirst)+len(out.Rules)+len(askLast))
		rules = append(rules, denyFirst...)
		rules = append(rules, out.Rules...)
		out.Rules = append(rules, askLast...)
	}

	if len(account.TierRules) > 0 {
		tiers := make(map[string]string, len(out.TierRules)+len(account.TierRules))
		for tier, decision := range out.TierRules {
			tiers[tier] = decision
		}
		for tier, decision := range account.TierRules {
			current, set := tiers[tier]
			if !set && decision == "allow" {
				c.ignore("permissions.tierRules", tier+":"+decision, reasonWouldAllow)
				continue
			}
			tiers[tier] = stricterPermissionMode(current, decision)
		}
		out.TierRules = tiers
	}
	return &out
}

func composeSandbox(machine, account *types.SandboxEnterpriseConfig) *types.SandboxEnterpriseConfig {
	if account == nil {
		return machine
	}
	if machine == nil {
		cp := *account
		return &cp
	}
	out := *machine
	out.Required = machine.Required || account.Required
	out.AllowDisable = machine.AllowDisable && account.AllowDisable
	out.AdditionalDenyPaths = unionStrings(machine.AdditionalDenyPaths, account.AdditionalDenyPaths)
	if len(account.AdditionalDangerousPatterns) > 0 {
		seen := make(map[string]bool, len(machine.AdditionalDangerousPatterns))
		patterns := append([]types.DangerousPattern(nil), machine.AdditionalDangerousPatterns...)
		for _, p := range patterns {
			seen[p.Pattern] = true
		}
		for _, p := range account.AdditionalDangerousPatterns {
			if !seen[p.Pattern] {
				seen[p.Pattern] = true
				patterns = append(patterns, p)
			}
		}
		out.AdditionalDangerousPatterns = patterns
	}
	return &out
}

func composeSecurity(machine, account *types.EnterpriseSecurityConfig) *types.EnterpriseSecurityConfig {
	if account == nil {
		return machine
	}
	out := types.EnterpriseSecurityConfig{}
	if machine != nil {
		out = *machine
	}
	out.RequirePrincipalPartitioning = out.RequirePrincipalPartitioning || account.RequirePrincipalPartitioning
	out.MinEnforcement = types.SealMinEnforcement(out.MinEnforcement, account.MinEnforcement)
	return &out
}

func composeLimits(machine, account *types.EnterpriseLimits) *types.EnterpriseLimits {
	if account == nil {
		return machine
	}
	out := types.EnterpriseLimits{}
	if machine != nil {
		out = *machine
	}
	// A nil plan-mode list is "no policy"; an empty one is "none allowed".
	if account.PlanModeAllowedBashCommands != nil {
		if out.PlanModeAllowedBashCommands == nil {
			out.PlanModeAllowedBashCommands = append([]string{}, account.PlanModeAllowedBashCommands...)
		} else {
			out.PlanModeAllowedBashCommands = keepWithinBashCeiling(account.PlanModeAllowedBashCommands, out.PlanModeAllowedBashCommands)
		}
	}
	if account.PlanModeAllowedMcpTools != nil {
		if out.PlanModeAllowedMcpTools == nil {
			out.PlanModeAllowedMcpTools = append([]string{}, account.PlanModeAllowedMcpTools...)
		} else {
			kept := make([]string, 0, len(account.PlanModeAllowedMcpTools))
			for _, tool := range account.PlanModeAllowedMcpTools {
				if entryWithinCeiling(tool, out.PlanModeAllowedMcpTools, "__") {
					kept = append(kept, tool)
				}
			}
			out.PlanModeAllowedMcpTools = kept
		}
	}
	if account.AgentStateMetadata != nil {
		meta := types.EnterpriseAgentStateMetadataLimits{}
		if out.AgentStateMetadata != nil {
			meta = *out.AgentStateMetadata
		}
		meta.MaxValueBytes = minPositiveIntPtr(meta.MaxValueBytes, account.AgentStateMetadata.MaxValueBytes)
		meta.MaxEntryBytes = minPositiveIntPtr(meta.MaxEntryBytes, account.AgentStateMetadata.MaxEntryBytes)
		meta.MaxSnapshotBytes = minPositiveIntPtr(meta.MaxSnapshotBytes, account.AgentStateMetadata.MaxSnapshotBytes)
		out.AgentStateMetadata = &meta
	}
	return &out
}

// keepWithinBashCeiling returns the entries of cmds the ceiling sanctions,
// by the same word-boundary prefix rule the enterprise ceiling uses.
func keepWithinBashCeiling(cmds, ceiling []string) []string {
	kept := make([]string, 0, len(cmds))
	for _, cmd := range cmds {
		if bashCommandWithinCeiling(cmd, ceiling) {
			kept = append(kept, cmd)
		}
	}
	return kept
}

func composeResourceLimits(machine, account *types.ResourceLimits) *types.ResourceLimits {
	if account == nil {
		return machine
	}
	out := types.ResourceLimits{}
	if machine != nil {
		out = *machine
	}
	out.MaxSessions = minIntPtr(out.MaxSessions, account.MaxSessions)
	out.MaxAgentsPerSession = minIntPtr(out.MaxAgentsPerSession, account.MaxAgentsPerSession)
	return &out
}

// providers lets an account pin provider definitions. An account key the
// machine's allowedProviders excludes would add a provider, so it is ignored.
func (c composer) providers(machine *types.EnterpriseConfig, account map[string]types.ProviderConfig) map[string]types.ProviderConfig {
	if len(account) == 0 {
		return machine.Providers
	}
	out := make(map[string]types.ProviderConfig, len(machine.Providers)+len(account))
	for key, def := range machine.Providers {
		out[key] = def
	}
	for key, def := range account {
		_, pinned := machine.Providers[key]
		if len(machine.AllowedProviders) > 0 && !pinned && !contains(machine.AllowedProviders, key) {
			c.ignore("providers", key, reasonOutsideCeiling)
			continue
		}
		out[key] = def
	}
	return out
}

func (c composer) protectedOperations(machine, account map[string]types.ProtectedOperationConfig) map[string]types.ProtectedOperationConfig {
	if len(account) == 0 {
		return machine
	}
	out := make(map[string]types.ProtectedOperationConfig, len(machine)+len(account))
	for name, op := range account {
		out[name] = op
	}
	for name, op := range machine {
		if _, clash := out[name]; clash {
			c.ignore("protectedOperations", name, "the machine policy defines this operation")
		}
		out[name] = op
	}
	return out
}

func composeAuth(machine, account *types.AuthConfig) *types.AuthConfig {
	if account == nil {
		return machine
	}
	out := *account
	out.RequireOperatorIdentity = account.RequireOperatorIdentity || (machine != nil && machine.RequireOperatorIdentity)
	return &out
}

func composeTelemetry(machine, account *types.TelemetryConfig) *types.TelemetryConfig {
	if account == nil {
		return machine
	}
	out := *account
	out.Enabled = account.Enabled || (machine != nil && machine.Enabled)
	return &out
}

func composeConversationEvents(machine, account *types.ConversationEventsConfig) *types.ConversationEventsConfig {
	if account == nil {
		return machine
	}
	out := *account
	out.Enabled = account.Enabled || (machine != nil && machine.Enabled)
	return &out
}

func composeGit(machine, account *types.EnterpriseGitConfig) *types.EnterpriseGitConfig {
	if account == nil {
		return machine
	}
	out := types.EnterpriseGitConfig{}
	if machine != nil {
		out = *machine
	}
	out.Required = out.Required || account.Required
	if account.Machine != nil {
		out.Machine = account.Machine
	}
	return &out
}

func composeNewConversationDefaults(machine, account *types.NewConversationDefaultsPolicy) *types.NewConversationDefaultsPolicy {
	if account == nil {
		return machine
	}
	out := *account
	if machine != nil {
		out.Locked = account.Locked || machine.Locked
		out.ProfileLocked = account.ProfileLocked || machine.ProfileLocked
	}
	return &out
}

// mergeCustomFields merges account over machine. Nested objects merge key by
// key; any other value is replaced.
func mergeCustomFields(machine, account map[string]any) map[string]any {
	if len(account) == 0 {
		return machine
	}
	out := make(map[string]any, len(machine)+len(account))
	for key, value := range machine {
		out[key] = value
	}
	for key, value := range account {
		base, baseIsMap := out[key].(map[string]any)
		over, overIsMap := value.(map[string]any)
		if baseIsMap && overIsMap {
			out[key] = mergeCustomFields(base, over)
			continue
		}
		out[key] = value
	}
	return out
}

func unionHooks(base, add []types.HookDef) []types.HookDef {
	if len(add) == 0 {
		return base
	}
	seen := make(map[types.HookDef]bool, len(base)+len(add))
	out := make([]types.HookDef, 0, len(base)+len(add))
	for _, list := range [][]types.HookDef{base, add} {
		for _, hook := range list {
			if !seen[hook] {
				seen[hook] = true
				out = append(out, hook)
			}
		}
	}
	return out
}

// minIntPtr returns the lower of two optional bounds. Nil is "no bound".
func minIntPtr(a, b *int) *int {
	if b == nil {
		return a
	}
	if a == nil || *b < *a {
		v := *b
		return &v
	}
	return a
}

// minPositiveIntPtr is minIntPtr for bounds where a value of zero or less
// means "no bound".
func minPositiveIntPtr(a, b *int) *int {
	if b == nil || *b <= 0 {
		return a
	}
	if a == nil || *a <= 0 {
		v := *b
		return &v
	}
	return minIntPtr(a, b)
}
