package config

// account_policy.go — resolving account policies against an account.
//
// Account policies live inside the machine enterprise policy, so the only
// place they can be written is the administrator-controlled machine source.
// No per-user location is read for them.
//
// Resolution happens in two steps:
//
//  1. Process scope. Entries that name only OS dimensions are matched once
//     against the operating-system account the engine runs as and composed
//     into the policy the whole process uses (LoadEnterpriseConfig).
//  2. Session scope. Entries that name a principal dimension are matched for
//     each session against that session's principal
//     (ResolveEnterpriseForPrincipal). Nothing resolved for one principal is
//     stored where another principal's resolution can read it.
//
// A session-scoped entry may carry only the fields the engine applies per
// session. The rest configure things that exist once per process, so they
// are dropped from such an entry and reported.

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// osAccount is the operating-system account the engine process runs as.
// Users holds every form the account may be named by (login name, bare name
// without a domain, stable id); Groups holds group names and stable ids.
type osAccount struct {
	Users  []string
	Groups []string
}

// currentOSAccount resolves the engine process's account. A var so a test
// can supply an account; production never reassigns it.
var currentOSAccount = cachedOSAccount

var (
	osAccountOnce  sync.Once
	osAccountValue osAccount
)

func cachedOSAccount() osAccount {
	osAccountOnce.Do(func() {
		osAccountValue = readOSAccount()
		utils.LogWithFields(utils.LevelInfo, "config.enterprise", "os account resolved for account policies", map[string]any{
			"users": osAccountValue.Users, "group_count": len(osAccountValue.Groups),
		})
	})
	return osAccountValue
}

// assetScopePattern bounds an asset scope to a name that is safe to use as
// one directory segment.
var assetScopePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func containsFold(list []string, candidates []string) bool {
	for _, want := range list {
		for _, have := range candidates {
			if strings.EqualFold(want, have) {
				return true
			}
		}
	}
	return false
}

// osMatches reports whether the OS dimensions of match select account.
func osMatches(match types.AccountMatch, account osAccount) bool {
	if len(match.OSUsers) > 0 && !containsFold(match.OSUsers, account.Users) {
		return false
	}
	if len(match.OSGroups) > 0 && !containsFold(match.OSGroups, account.Groups) {
		return false
	}
	return true
}

func accountPolicyLabel(entry types.AccountPolicy, index int) string {
	if entry.Name != "" {
		return entry.Name
	}
	return "accountPolicies[" + strconv.Itoa(index) + "]"
}

// resolveProcessAccountScope composes every OS-only account policy that
// matches the engine's own account into cfg. The result keeps only the
// session-scoped entries whose OS dimensions match, for per-session
// resolution later. cfg is not mutated.
func resolveProcessAccountScope(cfg *types.EnterpriseConfig) *types.EnterpriseConfig {
	if cfg == nil {
		return nil
	}
	if len(cfg.AccountPolicies) == 0 && len(cfg.AssetScopes) == 0 {
		return cfg
	}
	account := currentOSAccount()
	entries := cfg.AccountPolicies

	base := *cfg
	base.AccountPolicies = nil
	base.AssetScopes = nil
	out := &base

	var notes []composeNote
	var matched []string
	var pending []types.AccountPolicy
	for i, entry := range entries {
		label := accountPolicyLabel(entry, i)
		if !osMatches(entry.Match, account) {
			continue
		}
		if entry.Match.SessionScoped() {
			entry.Name = label
			entry.Policy = sessionScopedSubset(entry.Policy, label, &notes)
			pending = append(pending, entry)
			continue
		}
		matched = append(matched, label)
		out = applyAccountPolicy(out, entry, label, &notes)
	}
	out.AccountPolicies = pending
	reportAccountResolution("process", matched, len(pending), notes)
	return out
}

// applyAccountPolicy composes one matched entry and stamps its asset scope.
func applyAccountPolicy(cfg *types.EnterpriseConfig, entry types.AccountPolicy, label string, notes *[]composeNote) *types.EnterpriseConfig {
	out := composeAccountPolicy(cfg, entry.Policy, label, notes)
	if entry.AssetScope == "" {
		return out
	}
	if !assetScopePattern.MatchString(entry.AssetScope) {
		*notes = append(*notes, composeNote{Policy: label, Field: "assetScope", Value: entry.AssetScope, Reason: "not a valid scope name"})
		return out
	}
	if contains(out.AssetScopes, entry.AssetScope) {
		return out
	}
	if out == cfg {
		cp := *cfg
		out = &cp
	}
	out.AssetScopes = append(append([]string(nil), out.AssetScopes...), entry.AssetScope)
	return out
}

// sessionScopedSubset returns policy without the fields that configure
// process-wide machinery, noting each one it drops.
func sessionScopedSubset(policy *types.EnterpriseConfig, label string, notes *[]composeNote) *types.EnterpriseConfig {
	if policy == nil {
		return nil
	}
	out := *policy
	drop := func(field string, present bool) {
		if present {
			*notes = append(*notes, composeNote{Policy: label, Field: field, Reason: "applies once per engine process; set it in a policy that matches by osUsers or osGroups only"})
		}
	}
	drop("auth", out.Auth != nil)
	drop("subscriptionLookup", out.SubscriptionLookup != nil)
	drop("providers", len(out.Providers) > 0)
	drop("allowedProviders", len(out.AllowedProviders) > 0)
	drop("pluginAllowlist", len(out.PluginAllowlist) > 0)
	drop("pluginDenylist", len(out.PluginDenylist) > 0)
	drop("pluginForceInstalled", len(out.PluginForceInstalled) > 0)
	drop("telemetry", out.Telemetry != nil)
	drop("systemMetrics", out.SystemMetrics != nil)
	drop("applicationConfig", out.ApplicationConfig != nil)
	drop("protectedOperations", len(out.ProtectedOperations) > 0)
	drop("conversationEvents", out.ConversationEvents != nil)
	drop("network", out.Network != nil)
	drop("logging", out.Logging != nil)
	drop("security", out.Security != nil)
	drop("thinking", out.Thinking != nil)
	out.Auth, out.SubscriptionLookup, out.Providers, out.AllowedProviders = nil, nil, nil, nil
	out.PluginAllowlist, out.PluginDenylist, out.PluginForceInstalled = nil, nil, nil
	out.Telemetry, out.SystemMetrics, out.ApplicationConfig, out.ProtectedOperations = nil, nil, nil, nil
	out.ConversationEvents, out.Network, out.Logging, out.Security, out.Thinking = nil, nil, nil, nil, nil
	if out.ResourceLimits != nil && out.ResourceLimits.MaxSessions != nil {
		drop("resourceLimits.maxSessions", true)
		limits := *out.ResourceLimits
		limits.MaxSessions = nil
		out.ResourceLimits = &limits
	}
	return &out
}

// HasSessionScopedPolicies reports whether cfg carries account policies that
// still need resolving against a session's principal.
func HasSessionScopedPolicies(cfg *types.EnterpriseConfig) bool {
	return cfg != nil && len(cfg.AccountPolicies) > 0
}

// ResolveEnterpriseForPrincipal returns the policy that applies to a session
// run for principal: cfg with every matching session-scoped account policy
// composed in, and with no account policies left on it. cfg is the process
// policy LoadEnterpriseConfig returns and is not mutated.
//
// A nil principal matches no session-scoped entry, so an unattributed
// session gets the process policy.
func ResolveEnterpriseForPrincipal(cfg *types.EnterpriseConfig, principal *types.SessionPrincipal) *types.EnterpriseConfig {
	if !HasSessionScopedPolicies(cfg) {
		return cfg
	}
	base := *cfg
	base.AccountPolicies = nil
	out := &base

	var notes []composeNote
	var matched []string
	for i, entry := range cfg.AccountPolicies {
		if !principalMatches(principal, entry.Match.PrincipalMatch()) {
			continue
		}
		label := accountPolicyLabel(entry, i)
		matched = append(matched, label)
		out = applyAccountPolicy(out, entry, label, &notes)
	}
	subject := ""
	if principal != nil {
		subject = principal.Subject
	}
	reportAccountResolution("principal:"+subject, matched, 0, notes)
	return out
}

// LoadEnterpriseConfigFor loads the enterprise policy that applies to a
// session run for principal.
func LoadEnterpriseConfigFor(principal *types.SessionPrincipal) *types.EnterpriseConfig {
	return ResolveEnterpriseForPrincipal(LoadEnterpriseConfig(), principal)
}

// accountReportMax bounds the per-scope report memory.
const accountReportMax = 1024

var (
	accountReportMu   sync.Mutex
	accountReportLast = map[string]string{}
)

// reportAccountResolution logs which account policies a scope resolved and
// every value the composer refused. Enterprise policy is re-read on every
// config resolution, so this reports once per distinct outcome per scope.
func reportAccountResolution(scope string, matched []string, pending int, notes []composeNote) {
	sort.SliceStable(notes, func(i, j int) bool {
		if notes[i].Policy != notes[j].Policy {
			return notes[i].Policy < notes[j].Policy
		}
		return notes[i].Field < notes[j].Field
	})
	encoded, err := json.Marshal(struct {
		Matched []string
		Pending int
		Notes   []composeNote
	}{matched, pending, notes})
	if err != nil {
		encoded = []byte(err.Error())
	}
	state := string(encoded)

	accountReportMu.Lock()
	last, seen := accountReportLast[scope]
	if len(accountReportLast) >= accountReportMax && !seen {
		accountReportLast = map[string]string{}
	}
	accountReportLast[scope] = state
	accountReportMu.Unlock()
	if seen && last == state {
		return
	}

	if len(matched) == 0 && len(notes) == 0 {
		utils.LogWithFields(utils.LevelDebug, "config.enterprise", "no account policy matched", map[string]any{
			"scope": scope, "session_scoped_pending": pending,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "config.enterprise", "account policies resolved", map[string]any{
		"scope": scope, "matched": matched, "session_scoped_pending": pending, "ignored_count": len(notes),
	})
	for _, note := range notes {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "account policy value ignored", map[string]any{
			"scope": scope, "policy": note.Policy, "field": note.Field, "value": note.Value, "reason": note.Reason,
		})
	}
}

// nonEmpty returns the distinct non-empty values, in order.
func nonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" && !contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// firstPrincipal returns the principal of an optional trailing argument, or
// nil when the caller passed none.
func firstPrincipal(principal []*types.SessionPrincipal) *types.SessionPrincipal {
	if len(principal) == 0 {
		return nil
	}
	return principal[0]
}
