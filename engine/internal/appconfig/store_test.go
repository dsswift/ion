package appconfig

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

var operatorA = &auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: "subject-a"}
var operatorB = &auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: "subject-b"}

// scriptedFetcher answers each fetch from a queue of results and records
// every call, so tests control exactly what each resolution returns.
type scriptedFetcher struct {
	mu      sync.Mutex
	calls   atomic.Int64
	results []fetchResult
	gate    chan struct{} // when non-nil, each fetch waits for one receive
}

type fetchResult struct {
	values map[string]any
	err    error
}

func (f *scriptedFetcher) fetch(ctx context.Context, _ types.ApplicationConfigSource) (map[string]any, error) {
	f.calls.Add(1)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.results) == 0 {
		return map[string]any{}, nil
	}
	next := f.results[0]
	if len(f.results) > 1 {
		f.results = f.results[1:]
	}
	return next.values, next.err
}

func newTestStore(t *testing.T, fetcher *scriptedFetcher, refresh time.Duration) *Store {
	t.Helper()
	store := NewStore(types.ApplicationConfigSource{Endpoint: "https://config.example.invalid"}, fetcher.fetch)
	store.refresh = refresh
	t.Cleanup(store.Stop)
	return store
}

func awaitState(t *testing.T, store *Store, subject string, want State) Snapshot {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if snap := store.Snapshot().For(subject); snap.State == want {
			return snap
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("state never reached %q; last %+v", want, store.Snapshot())
	return Snapshot{}
}

func TestStoreDeferredUntilPrincipalAvailable(t *testing.T) {
	fetcher := &scriptedFetcher{}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(nil, "initial")
	if snap := store.Snapshot(); snap.State != StateDeferred || snap.Values != nil {
		t.Fatalf("no principal must stay deferred with no values: %+v", snap)
	}
	if fetcher.calls.Load() != 0 {
		t.Fatalf("no principal must never fetch; calls=%d", fetcher.calls.Load())
	}
}

func TestStoreFetchingThenReady(t *testing.T) {
	fetcher := &scriptedFetcher{gate: make(chan struct{}), results: []fetchResult{{values: map[string]any{"region": "east"}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	if snap := store.Snapshot(); snap.State != StateFetching || snap.Subject != "subject-a" {
		t.Fatalf("resolution in flight must read fetching for the principal: %+v", snap)
	}
	if _, found := store.Snapshot().Lookup("region"); found {
		t.Fatal("a key must not be found before the snapshot is ready")
	}
	fetcher.gate <- struct{}{}
	snap := awaitState(t, store, "", StateReady)
	if value, found := snap.Lookup("region"); !found || value != "east" {
		t.Fatalf("ready snapshot must carry the resolved value: %+v", snap)
	}
	if _, found := snap.Lookup("missing"); found {
		t.Fatal("a ready snapshot must report an absent key as not found")
	}
	if snap.FetchedAt == "" {
		t.Fatal("ready snapshot must record when it was fetched")
	}
}

func TestStoreFetchesOncePerIdentity(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"k": "v"}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateReady)
	for _, reason := range []string{"renewed", "reconciled", "initial"} {
		copyA := *operatorA
		store.applyIdentity(&copyA, reason)
	}
	time.Sleep(20 * time.Millisecond)
	if calls := fetcher.calls.Load(); calls != 1 {
		t.Fatalf("an unchanged identity must not refetch; calls=%d", calls)
	}
}

func TestStoreFailedCarriesReasonAndRetries(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{
		{err: errors.New("endpoint returned status 503")},
		{values: map[string]any{"k": "v"}},
	}}
	store := newTestStore(t, fetcher, 10*time.Millisecond)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateFailed)
	if snap := store.Snapshot(); snap.Error != "endpoint returned status 503" || snap.Values != nil {
		t.Fatalf("failed snapshot must carry the reason and no values: %+v", snap)
	}
	awaitState(t, store, "", StateReady)
}

func TestStoreRefreshIsAtomic(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{
		{values: map[string]any{"old": 1.0, "shared": "first"}},
		{values: map[string]any{"shared": "second"}},
	}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	first := awaitState(t, store, "", StateReady)

	// Hold the refresh open and prove readers keep the whole previous
	// snapshot while it runs: a refresh never passes back through fetching.
	fetcher.gate = make(chan struct{})
	store.mu.Lock()
	generation := store.generation
	store.mu.Unlock()
	done := make(chan struct{})
	go func() {
		values, err := store.fetch(context.Background(), store.source)
		store.complete(generation, "subject-a", "entra", values, err)
		close(done)
	}()
	for fetcher.calls.Load() < 2 {
		time.Sleep(time.Millisecond)
	}
	if during := store.Snapshot(); during.State != StateReady || during.Revision != first.Revision || during.Values["old"] != 1.0 {
		t.Fatalf("readers must see the previous snapshot during refresh: %+v", during)
	}
	fetcher.gate <- struct{}{}
	<-done
	next := store.Snapshot()
	if next.Revision != first.Revision+1 || next.Values["shared"] != "second" {
		t.Fatalf("refresh must install the next snapshot: %+v", next)
	}
	if _, found := next.Lookup("old"); found {
		t.Fatalf("refresh must replace the snapshot whole, never merge: %+v", next.Values)
	}
}

func TestStoreRefreshFailureKeepsPreviousSnapshot(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"k": "v"}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	ready := awaitState(t, store, "", StateReady)
	store.complete(store.generation, "subject-a", "entra", nil, errors.New("timeout"))
	if after := store.Snapshot(); after.State != StateReady || after.Revision != ready.Revision || after.Values["k"] != "v" {
		t.Fatalf("a failed refresh must keep the previous snapshot: %+v", after)
	}
}

func TestStoreSignOutPurgesAndDiscardsInFlight(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"secret": "a-only"}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateReady)

	store.applyIdentity(nil, "signed_out")
	if snap := store.Snapshot(); snap.State != StateDeferred || snap.Values != nil || snap.Subject != "" {
		t.Fatalf("sign-out must purge to deferred: %+v", snap)
	}

	// A resolution that completes after its identity was purged must not
	// resurrect the snapshot.
	fetcher.gate = make(chan struct{})
	store.applyIdentity(operatorA, "signed_in")
	store.mu.Lock()
	stale := store.generation
	store.mu.Unlock()
	store.applyIdentity(nil, "verification_lost")
	store.complete(stale, "subject-a", "entra", map[string]any{"secret": "a-only"}, nil)
	if snap := store.Snapshot(); snap.State != StateDeferred || snap.Values != nil {
		t.Fatalf("a purged generation's result must be discarded: %+v", snap)
	}
}

func TestStoreIdentitySwitchResolvesForNewPrincipal(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{
		{values: map[string]any{"owner": "a"}},
		{values: map[string]any{"owner": "b"}},
	}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateReady)
	store.applyIdentity(operatorB, "signed_in")
	snap := awaitState(t, store, "subject-b", StateReady)
	if snap.Subject != "subject-b" || snap.Values["owner"] != "b" {
		t.Fatalf("a new principal must get its own snapshot: %+v", snap)
	}
	if other := store.Snapshot().For("subject-a"); other.State != StateDeferred || other.Values != nil {
		t.Fatalf("the previous principal must no longer see values: %+v", other)
	}
}

func TestStoreAwait(t *testing.T) {
	fetcher := &scriptedFetcher{gate: make(chan struct{}), results: []fetchResult{{values: map[string]any{"k": "v"}}}}
	store := newTestStore(t, fetcher, time.Hour)

	short, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	snap, err := store.Await(short, "")
	if !errors.Is(err, context.DeadlineExceeded) || snap.State != StateDeferred {
		t.Fatalf("await with no principal must time out deferred: %+v %v", snap, err)
	}

	result := make(chan Snapshot, 1)
	go func() {
		snap, err := store.Await(context.Background(), "")
		if err != nil {
			t.Errorf("await: %v", err)
		}
		result <- snap
	}()
	store.applyIdentity(operatorA, "signed_in")
	fetcher.gate <- struct{}{}
	select {
	case snap := <-result:
		if snap.State != StateReady || snap.Values["k"] != "v" {
			t.Fatalf("await must return the ready snapshot: %+v", snap)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("await never woke on readiness")
	}
}

func TestSnapshotForOtherPrincipalIsDeferred(t *testing.T) {
	ready := Snapshot{State: StateReady, Revision: 4, Subject: "subject-a", Values: map[string]any{"k": "v"}}
	if view := ready.For("subject-b"); view.State != StateDeferred || view.Values != nil || view.Revision != 4 {
		t.Fatalf("another principal must read deferred: %+v", view)
	}
	if view := ready.For(""); view.State != StateReady || view.Values["k"] != "v" {
		t.Fatalf("the process view must be unchanged: %+v", view)
	}
	view := ready.For("subject-a")
	view.Values["k"] = "mutated"
	if ready.Values["k"] != "v" {
		t.Fatal("a reader's view must not alias the snapshot's values")
	}
}

func TestSubscribersReceiveTransitionsInOrder(t *testing.T) {
	var mu sync.Mutex
	var seen []State
	var revisions []uint64
	stop := Subscribe(func(snap Snapshot) {
		mu.Lock()
		seen = append(seen, snap.State)
		revisions = append(revisions, snap.Revision)
		mu.Unlock()
	})
	defer stop()
	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"k": "v"}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateReady)
	store.applyIdentity(nil, "signed_out")
	store.Stop() // drains queued deliveries
	mu.Lock()
	defer mu.Unlock()
	want := []State{StateFetching, StateReady, StateDeferred}
	if len(seen) != len(want) {
		t.Fatalf("transitions = %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] || revisions[i] != uint64(i+1) {
			t.Fatalf("transitions = %v revisions %v, want %v in order", seen, revisions, want)
		}
	}
}

func TestReadWithNoStoreIsDisabled(t *testing.T) {
	Install(nil)
	if snap := Read("subject-a"); snap.State != StateDisabled {
		t.Fatalf("an unconfigured engine must read disabled: %+v", snap)
	}
	snap, err := Await(context.Background(), "")
	if err != nil || snap.State != StateDisabled {
		t.Fatalf("await on an unconfigured engine must return disabled at once: %+v %v", snap, err)
	}
}
