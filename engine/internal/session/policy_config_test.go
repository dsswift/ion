package session

import (
	"reflect"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
)

func accountPolicyConfig() *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		DefaultModel: "model-c",
		Enterprise: &types.EnterpriseConfig{
			AllowedModels: []string{"model-a", "model-b", "model-c"},
			AccountPolicies: []types.AccountPolicy{
				{Name: "contractors", Match: types.AccountMatch{Subjects: []string{"contractor@example.com"}},
					Policy: &types.EnterpriseConfig{
						AllowedModels: []string{"model-a"},
						Permissions:   &types.PermissionPolicy{Mode: "deny"},
						Sandbox: &types.SandboxEnterpriseConfig{Required: true,
							AdditionalDangerousPatterns: []types.DangerousPattern{{Pattern: `curl\s`, Reason: "no network"}}},
					}},
				{Name: "qa", Match: types.AccountMatch{Subjects: []string{"qa@example.com"}},
					Policy: &types.EnterpriseConfig{AllowedModels: []string{"model-b"}}},
			},
		},
	}
}

func testPrincipal(subject string) *types.SessionPrincipal {
	return &types.SessionPrincipal{Subject: subject, Provider: "entra", Kind: "operator"}
}

// TestPolicyConfig_PerPrincipal pins that each principal's sessions see the
// policy resolved for that principal and nobody else's.
func TestPolicyConfig_PerPrincipal(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	mgr.SetConfig(accountPolicyConfig())

	contractor := mgr.policyView(testPrincipal("contractor@example.com"))
	if got := contractor.cfg.Enterprise.AllowedModels; !reflect.DeepEqual(got, []string{"model-a"}) {
		t.Errorf("contractor allowedModels = %v", got)
	}
	if contractor.cfg.DefaultModel != "model-a" {
		t.Errorf("contractor defaultModel = %q, want the model its policy allows", contractor.cfg.DefaultModel)
	}
	if contractor.cfg.Permissions == nil || contractor.cfg.Permissions.Mode != "deny" {
		t.Errorf("contractor permissions = %+v", contractor.cfg.Permissions)
	}
	if len(contractor.patterns) != 1 {
		t.Errorf("contractor command patterns = %d, want 1", len(contractor.patterns))
	}
	if buildSandboxConfig(mgr, testPrincipal("contractor@example.com")) == nil {
		t.Error("contractor policy requires the sandbox")
	}

	qa := mgr.policyView(testPrincipal("qa@example.com"))
	if got := qa.cfg.Enterprise.AllowedModels; !reflect.DeepEqual(got, []string{"model-b"}) {
		t.Errorf("qa allowedModels = %v", got)
	}
	if qa.cfg.Permissions != nil || len(qa.patterns) != 0 || buildSandboxConfig(mgr, testPrincipal("qa@example.com")) != nil {
		t.Errorf("qa session got the contractor policy: permissions=%+v patterns=%d", qa.cfg.Permissions, len(qa.patterns))
	}

	for name, p := range map[string]*types.SessionPrincipal{"unmatched": testPrincipal("it@example.com"), "unattributed": nil} {
		view := mgr.policyView(p)
		if got := view.cfg.Enterprise.AllowedModels; len(got) != 3 || view.cfg.DefaultModel != "model-c" {
			t.Errorf("%s session got an account's policy: %v", name, got)
		}
		if len(view.cfg.Enterprise.AccountPolicies) != 0 {
			t.Errorf("%s session config exposes the account policy list", name)
		}
	}

	s := &engineSession{}
	mgr.wireSessionPermissions(s, testPrincipal("contractor@example.com"))
	if got := s.permEngine.Check(permissions.CheckInfo{Tool: "Write"}); got.Decision != "deny" {
		t.Errorf("contractor session permission decision = %q, want deny", got.Decision)
	}
	mgr.wireSessionPermissions(s, testPrincipal("qa@example.com"))
	if got := s.permEngine.Check(permissions.CheckInfo{Tool: "Write"}); got.Decision != "allow" {
		t.Errorf("qa session permission decision = %q, want allow", got.Decision)
	}
}

// TestPolicyConfig_NoAccountPolicies pins that a host with no
// principal-scoped policy hands every session the process config itself.
func TestPolicyConfig_NoAccountPolicies(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	cfg := &types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{AllowedModels: []string{"model-a"}}}
	mgr.SetConfig(cfg)
	if got := mgr.policyConfig(testPrincipal("anyone@example.com")); got != cfg {
		t.Error("with no account policies every principal must get the process config")
	}
	if got := NewManager(backend.NewApiBackend()).policyConfig(nil); got != nil {
		t.Error("a manager with no config must resolve nil")
	}
}

// TestPolicyConfig_ConcurrentSessions resolves two accounts from many
// goroutines at once. Run under -race.
func TestPolicyConfig_ConcurrentSessions(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	mgr.SetConfig(accountPolicyConfig())
	want := map[string][]string{"contractor@example.com": {"model-a"}, "qa@example.com": {"model-b"}}

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		for subject, models := range want {
			wg.Add(1)
			go func(subject string, models []string) {
				defer wg.Done()
				got := mgr.policyConfig(testPrincipal(subject)).Enterprise.AllowedModels
				if !reflect.DeepEqual(got, models) {
					t.Errorf("%s resolved %v, want %v", subject, got, models)
				}
			}(subject, models)
		}
	}
	wg.Wait()
}
