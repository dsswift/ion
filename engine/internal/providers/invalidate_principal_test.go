package providers

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestInvalidatePrincipal_DropsAllThreeCaches pins R-18/R-30: one call to
// providers.InvalidatePrincipal -- the actual single entry point R-18
// describes -- drops the HasKey negative cache, the authenticator/token
// cache, AND the entitlement cache together. A caller cannot half-invalidate
// by calling only one of the three underlying primitives.
func TestInvalidatePrincipal_DropsAllThreeCaches(t *testing.T) {
	auth.InvalidateAllHasKey()
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() {
		auth.InvalidateAllHasKey()
		ResetRegistries()
		restoreInitRegistries()
		ResetDiscoveryCache()
		ResetEntitlementForTest()
	})

	// Seed all three caches for "alice"/"gw".
	r := auth.NewResolver(nil)
	if ok, _ := r.HasKeyForSubject("alice", "gw"); ok {
		t.Fatal("precondition: alice should have no credential for gw")
	}
	fetch := func(context.Context) ([]types.ModelEntry, error) {
		return []types.ModelEntry{{ID: "m1", ProviderID: "gw"}}, nil
	}
	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	auth.SetAuthenticatorCacheEntryForTest("alice", "gw")

	InvalidatePrincipal("alice", "gw")

	if auth.HasNegativeForTest("alice", "gw") {
		t.Error("expected the HasKey negative cache to be dropped")
	}
	if auth.HasAuthenticatorCacheEntryForTest("alice", "gw") {
		t.Error("expected the authenticator/token cache entry to be dropped")
	}
	entMu.Lock()
	_, entitlementStillCached := entCache[entitlementKey{Subject: "alice", Provider: "gw"}]
	entMu.Unlock()
	if entitlementStillCached {
		t.Error("expected the entitlement cache entry to be dropped")
	}
}
