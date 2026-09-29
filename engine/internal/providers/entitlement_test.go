package providers

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestEntitlementPerPrincipal_DifferentSets(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	aliceFetch := func(context.Context) ([]types.ModelEntry, error) {
		return []types.ModelEntry{{ID: "m1", ProviderID: "gw"}, {ID: "m2", ProviderID: "gw"}}, nil
	}
	bobFetch := func(context.Context) ([]types.ModelEntry, error) {
		return []types.ModelEntry{{ID: "m2", ProviderID: "gw"}}, nil
	}

	aliceIDs, err := EntitlementFor(context.Background(), "alice", "gw", aliceFetch)
	if err != nil {
		t.Fatal(err)
	}
	bobIDs, err := EntitlementFor(context.Background(), "bob", "gw", bobFetch)
	if err != nil {
		t.Fatal(err)
	}

	if len(aliceIDs) != 2 {
		t.Fatalf("alice ids = %v, want 2 entries", aliceIDs)
	}
	if len(bobIDs) != 1 || bobIDs[0] != "m2" {
		t.Fatalf("bob ids = %v, want [m2]", bobIDs)
	}
}

func TestEntitlementSingleflight_OneFetch(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	var calls int32
	started := make(chan struct{})
	var once sync.Once
	release := make(chan struct{})
	fetch := func(context.Context) ([]types.ModelEntry, error) {
		atomic.AddInt32(&calls, 1)
		once.Do(func() { close(started) })
		<-release
		return []types.ModelEntry{{ID: "m1", ProviderID: "gw"}}, nil
	}

	var wg sync.WaitGroup
	results := make([][]string, 5)
	for i := range results {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ids, _ := EntitlementFor(context.Background(), "alice", "gw", fetch)
			results[idx] = ids
		}(i)
	}
	<-started
	close(release)
	wg.Wait()

	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("expected 1 fetch call, got %d (singleflight broken)", n)
	}
	for i, r := range results {
		if len(r) != 1 || r[0] != "m1" {
			t.Errorf("goroutine %d got %v, want [m1]", i, r)
		}
	}
}

func TestEntitlementStaleness_PerKey24h(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	calls := 0
	fetch := func(context.Context) ([]types.ModelEntry, error) {
		calls++
		return []types.ModelEntry{{ID: "m1", ProviderID: "gw"}}, nil
	}

	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	// Second call within the staleness window is a cache hit.
	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("expected cache hit to skip fetch, got %d calls", calls)
	}

	// Force staleness by rewriting the cache entry's fetchedAt directly.
	entMu.Lock()
	entCache[entitlementKey{Subject: "alice", Provider: "gw"}].fetchedAt = time.Now().Add(-25 * time.Hour)
	entMu.Unlock()

	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("expected a stale entry to trigger a re-fetch, got %d calls", calls)
	}
}

func TestDialectStaysShared(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	fetch := func(context.Context) ([]types.ModelEntry, error) {
		return []types.ModelEntry{{ID: "shared-model", ProviderID: "gw", Dialect: "anthropic"}}, nil
	}

	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	if _, err := EntitlementFor(context.Background(), "bob", "gw", fetch); err != nil {
		t.Fatal(err)
	}

	info := GetModelInfo("shared-model")
	if info == nil {
		t.Fatal("expected shared-model to be registered in modelRegistry")
	}
	if info.Dialect != "anthropic" {
		t.Errorf("dialect = %q, want anthropic (dialect is a property of the model, not the caller)", info.Dialect)
	}
}

func TestDiscoveryFailureFallsBackToCatalog(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	fetchErr := errors.New("stub fetch error")
	fetch := func(context.Context) ([]types.ModelEntry, error) {
		return nil, fetchErr
	}
	ids, err := EntitlementFor(context.Background(), "alice", "gw", fetch)
	if err == nil {
		t.Fatal("expected an error from a failed fetch")
	}
	if ids != nil {
		t.Errorf("expected nil ids on failure, got %v", ids)
	}
}

func TestUnknownEntitlementDoesNotFilter(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	// EntitlementForPrincipal returns (nil, nil) for a provider with no base
	// URL configured -- "not yet discovered", which callers must treat as
	// "do not filter", never as "entitled to nothing".
	ids, err := EntitlementForPrincipal(context.Background(), "alice", "no-such-provider", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ids != nil {
		t.Errorf("expected nil (unknown) entitlement for a provider with no base URL, got %v", ids)
	}
}

func TestInvalidateEntitlement_DropsCachedEntry(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	calls := 0
	fetch := func(context.Context) ([]types.ModelEntry, error) {
		calls++
		return []types.ModelEntry{{ID: "m1", ProviderID: "gw"}}, nil
	}
	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	InvalidateEntitlement("alice", "gw")
	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("expected invalidation to force a re-fetch, got %d calls", calls)
	}
}

func TestInvalidateEntitlement_ScopedToSubject(t *testing.T) {
	ResetRegistries()
	ResetDiscoveryCache()
	ResetEntitlementForTest()
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache(); ResetEntitlementForTest() })

	fetch := func(context.Context) ([]types.ModelEntry, error) {
		return []types.ModelEntry{{ID: "m1", ProviderID: "gw"}}, nil
	}
	if _, err := EntitlementFor(context.Background(), "alice", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	if _, err := EntitlementFor(context.Background(), "bob", "gw", fetch); err != nil {
		t.Fatal(err)
	}
	InvalidateEntitlement("alice", "gw")

	entMu.Lock()
	_, bobStillCached := entCache[entitlementKey{Subject: "bob", Provider: "gw"}]
	_, aliceStillCached := entCache[entitlementKey{Subject: "alice", Provider: "gw"}]
	entMu.Unlock()

	if !bobStillCached {
		t.Error("expected bob's cache entry to survive alice's invalidation")
	}
	if aliceStillCached {
		t.Error("expected alice's cache entry to be dropped")
	}
}
