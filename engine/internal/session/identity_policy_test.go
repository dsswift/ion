package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/extension"
)

type identityPolicyProvider struct{ identity *auth.ContextIdentity }

func (p *identityPolicyProvider) ContextIdentity() *auth.ContextIdentity { return p.identity }

func TestIdentityPolicyComposition(t *testing.T) {
	plan := func(name, requirement string) extension.ResolvedExtensionPlan {
		return extension.ResolvedExtensionPlan{Identifier: name, Manifest: &extension.Manifest{Identity: &extension.ManifestIdentity{Required: requirement}}}
	}
	cases := []struct {
		name   string
		plans  []extension.ResolvedExtensionPlan
		global bool
		want   identityRequirement
		err    string
	}{
		{"optional", nil, false, identityOptional, ""},
		{"any", []extension.ResolvedExtensionPlan{plan("any", "any")}, false, identityAny, ""},
		{"operator", []extension.ResolvedExtensionPlan{plan("operator", "operator")}, false, identityOperator, ""},
		{"workload", []extension.ResolvedExtensionPlan{plan("workload", "workload")}, false, identityWorkload, ""},
		{"any plus operator", []extension.ResolvedExtensionPlan{plan("any", "any"), plan("operator", "operator")}, false, identityOperator, ""},
		{"global operator", []extension.ResolvedExtensionPlan{plan("any", "any")}, true, identityOperator, ""},
		{"conflict", []extension.ResolvedExtensionPlan{plan("operator-ext", "operator"), plan("workload-ext", "workload")}, false, identityOptional, "operator-ext"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := identityPolicyFor(tc.plans, tc.global)
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.requirement != tc.want {
				t.Fatalf("requirement = %q, want %q", got.requirement, tc.want)
			}
		})
	}
}

func TestIdentityPolicyAsyncResolverRechecksAfterIdentityLoss(t *testing.T) {
	previous := auth.CurrentContextIdentityProvider()
	provider := &identityPolicyProvider{identity: &auth.ContextIdentity{Kind: "operator"}}
	auth.SetContextIdentityProvider(provider)
	t.Cleanup(func() { auth.SetContextIdentityProvider(previous) })

	mgr := NewManager(newMockBackend())
	mgr.mu.Lock()
	mgr.sessions["required"] = &engineSession{key: "required", identityPolicy: identityPolicy{requirement: identityOperator, extensions: []string{"required-extension"}}}
	mgr.mu.Unlock()
	host := extension.NewHost()
	host.SetSessionKey("required")
	resolver := mgr.buildAsyncContextResolver()
	if _, err := resolver(host); err != nil {
		t.Fatal(err)
	}
	provider.identity = nil
	if _, err := resolver(host); err == nil {
		t.Fatal("async resolver accepted missing required identity")
	}
	provider.identity = &auth.ContextIdentity{Kind: "operator"}
	if _, err := resolver(host); err != nil {
		t.Fatal(err)
	}
}
func TestIdentityPolicyRechecksCachedIdentity(t *testing.T) {
	previous := auth.CurrentContextIdentityProvider()
	provider := &identityPolicyProvider{identity: &auth.ContextIdentity{Kind: "operator"}}
	auth.SetContextIdentityProvider(provider)
	t.Cleanup(func() { auth.SetContextIdentityProvider(previous) })
	policy := identityPolicy{requirement: identityOperator, extensions: []string{"required-extension"}}
	if err := policy.check("test", "prompt dispatch"); err != nil {
		t.Fatal(err)
	}
	provider.identity = nil
	if err := policy.check("test", "prompt dispatch"); err == nil {
		t.Fatal("missing identity accepted")
	}
	provider.identity = &auth.ContextIdentity{Kind: "operator"}
	if err := policy.check("test", "async dispatch"); err != nil {
		t.Fatal(err)
	}
}
