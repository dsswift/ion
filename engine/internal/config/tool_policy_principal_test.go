package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func alicePrincipal() *types.SessionPrincipal {
	return &types.SessionPrincipal{Subject: "oidc:alice", Provider: "entra", Kind: "operator"}
}

func bobPrincipal() *types.SessionPrincipal {
	return &types.SessionPrincipal{Subject: "oidc:bob", Provider: "entra", Kind: "operator", Claims: map[string]any{"roles": []any{"contractor"}}}
}

func TestIsToolAllowedFor_NoRulesFallsThroughToGlobalPolicy(t *testing.T) {
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Deny: []string{"bash"}}}
	if IsToolAllowedFor("bash", alicePrincipal(), enterprise) {
		t.Error("expected the global deny to apply with no principal rules present")
	}
	if !IsToolAllowedFor("read", alicePrincipal(), enterprise) {
		t.Error("expected read to be allowed with no principal rules present")
	}
}

func TestIsToolAllowedFor_GlobalDenyWinsOverAPrincipalAllow(t *testing.T) {
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Deny: []string{"bash"},
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Subjects: []string{"oidc:alice"}}, Allow: []string{"bash"}},
		},
	}}
	if IsToolAllowedFor("bash", alicePrincipal(), enterprise) {
		t.Error("an enterprise-wide deny must win even over a principal-specific allow")
	}
}

func TestIsToolAllowedFor_SubjectMatchDeniesOnlyThatPrincipal(t *testing.T) {
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Subjects: []string{"oidc:alice"}}, Deny: []string{"bash"}},
		},
	}}
	if IsToolAllowedFor("bash", alicePrincipal(), enterprise) {
		t.Error("expected alice's bash denied by the matching subject rule")
	}
	if !IsToolAllowedFor("bash", bobPrincipal(), enterprise) {
		t.Error("expected bob unaffected by a rule that only names alice")
	}
}

func TestIsToolAllowedFor_ClaimMatchAppliesToEveryPrincipalWithThatRole(t *testing.T) {
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Claims: map[string][]string{"roles": {"contractor"}}}, Deny: []string{"bash"}},
		},
	}}
	if !IsToolAllowedFor("bash", alicePrincipal(), enterprise) {
		t.Error("alice has no contractor claim; expected bash allowed")
	}
	if IsToolAllowedFor("bash", bobPrincipal(), enterprise) {
		t.Error("bob's contractor claim should match the rule and deny bash")
	}
}

func TestIsToolAllowedFor_ProviderMatch(t *testing.T) {
	local := &types.SessionPrincipal{Subject: "local:josh", Provider: "os", Kind: "local"}
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Providers: []string{"entra"}}, Deny: []string{"bash"}},
		},
	}}
	if !IsToolAllowedFor("bash", local, enterprise) {
		t.Error("local (provider=os) should be unaffected by a rule scoped to provider=entra")
	}
	if IsToolAllowedFor("bash", alicePrincipal(), enterprise) {
		t.Error("alice (provider=entra) should be denied by the provider-scoped rule")
	}
}

func TestIsToolAllowedFor_UnattributedPrincipalOnlyMatchesAWildcardRule(t *testing.T) {
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Subjects: []string{"oidc:alice"}}, Deny: []string{"bash"}},
		},
	}}
	if !IsToolAllowedFor("bash", nil, enterprise) {
		t.Error("an unattributed (nil) principal must not match a subject-scoped rule")
	}
}

func TestIsToolAllowedFor_AllowListsFromMultipleMatchingRulesIntersect(t *testing.T) {
	// alice matches two rules by subject AND a wildcard-ish claim rule she
	// happens to also satisfy; each rule's allowlist independently narrows.
	enterprise := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Subjects: []string{"oidc:alice"}}, Allow: []string{"read", "bash"}},
			{Match: types.PrincipalMatch{Providers: []string{"entra"}}, Allow: []string{"read", "write"}},
		},
	}}
	if IsToolAllowedFor("bash", alicePrincipal(), enterprise) {
		t.Error("bash is in the first rule's allowlist but not the second's; expected refused (intersection)")
	}
	if !IsToolAllowedFor("read", alicePrincipal(), enterprise) {
		t.Error("read is in both matching rules' allowlists; expected allowed")
	}
}

func TestToolBlockReason(t *testing.T) {
	denyAll := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Deny: []string{"bash"}}}
	if source, _ := ToolBlockReason("bash", alicePrincipal(), denyAll); source != "denylist" {
		t.Errorf("expected source=denylist, got %q", source)
	}

	allowOnly := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Allow: []string{"read"}}}
	if source, _ := ToolBlockReason("bash", alicePrincipal(), allowOnly); source != "allowlist" {
		t.Errorf("expected source=allowlist, got %q", source)
	}

	principalRule := &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{
		Principals: []types.PrincipalToolRule{
			{Match: types.PrincipalMatch{Subjects: []string{"oidc:alice"}}, Deny: []string{"bash"}},
		},
	}}
	source, rule := ToolBlockReason("bash", alicePrincipal(), principalRule)
	if source != "principal" {
		t.Errorf("expected source=principal, got %q", source)
	}
	if rule != "oidc:alice" {
		t.Errorf("expected rule to name the matched subject, got %q", rule)
	}

	if source, _ := ToolBlockReason("read", alicePrincipal(), denyAll); source != "" {
		t.Errorf("expected empty source for an allowed tool, got %q", source)
	}
}
