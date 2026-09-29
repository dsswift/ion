package auth

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRequiresPrincipalCredential_NilConfig(t *testing.T) {
	if RequiresPrincipalCredential(nil) {
		t.Fatal("expected nil config to not require a principal credential")
	}
}

func TestRequiresPrincipalCredential_PartitioningOffIsFalse(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: false},
		},
	}
	if RequiresPrincipalCredential(cfg) {
		t.Fatal("expected disabled partitioning to not require a principal credential")
	}
}

func TestRequiresPrincipalCredential_PartitioningEnabledIsTrue(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true},
		},
	}
	if !RequiresPrincipalCredential(cfg) {
		t.Fatal("expected enabled partitioning to require a principal credential")
	}
}

// TestRequiresPrincipalCredential_EnterpriseForces pins that an
// enterprise-forced partitioning requirement is already folded into
// EngineRuntimeConfig by the time this function runs (config/merge.go's
// RequirePrincipalPartitioning seal sets Security.PrincipalPartitioning.
// Enabled=true regardless of the user layer) -- so simulating the merged
// result is the correct way to prove the enterprise case here, without this
// package depending on internal/config (which would be a cycle).
func TestRequiresPrincipalCredential_EnterpriseForces(t *testing.T) {
	// This is what config/merge.go produces when enterprise.Security.
	// RequirePrincipalPartitioning is true and the user layer never
	// configured partitioning at all.
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true},
		},
	}
	if !RequiresPrincipalCredential(cfg) {
		t.Fatal("expected the enterprise-forced (merged) config to require a principal credential")
	}
}

func TestFallThrough_UnattributedAlwaysAllowed(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true},
		},
	}
	policy := NewTenancyFallThroughPolicy(cfg)
	if !policy.AllowFallThrough("") {
		t.Fatal("expected an unattributed subject to always fall through, even when partitioning is required")
	}
}

func TestFallThrough_RefusedByDefaultWhenRequired(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true},
		},
	}
	policy := NewTenancyFallThroughPolicy(cfg)
	if policy.AllowFallThrough("alice") {
		t.Fatal("expected an attributed principal to be refused by default when principal credentials are required")
	}
}

func TestFallThrough_AllowedByExplicitOptIn(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			PrincipalPartitioning: &types.PrincipalPartitioningConfig{
				Enabled:                    true,
				AllowCredentialFallThrough: true,
			},
		},
	}
	policy := NewTenancyFallThroughPolicy(cfg)
	if !policy.AllowFallThrough("alice") {
		t.Fatal("expected the explicit opt-in to allow fall-through for an attributed principal")
	}
}

func TestFallThrough_NotRequiredAlwaysAllows(t *testing.T) {
	// No partitioning configured at all: single-tenant, never refused.
	policy := NewTenancyFallThroughPolicy(nil)
	if !policy.AllowFallThrough("alice") {
		t.Fatal("expected an attributed principal to fall through when principal credentials are not required")
	}
}
