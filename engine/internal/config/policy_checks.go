package config

// policy_checks.go — the questions callers ask of a merged enterprise policy:
// is this model, tool, MCP server, or plugin permitted.

import (
	"path"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

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
