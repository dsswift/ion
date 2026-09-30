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
// every call and the validators it carried, so tests control exactly what
// each resolution returns.
type scriptedFetcher struct {
	mu      sync.Mutex
	calls   atomic.Int64
	results []fetchResult
	priors  []Validators
	gate    chan struct{} // when non-nil, each fetch waits for one receive
}

type fetchResult struct {
	result FetchResult
	err    error
}

// commonDoc builds a result whose document carries values in the common
// section only.
func commonDoc(values map[string]any) fetchResult {
	return fetchResult{result: FetchResult{Document: &Document{Common: Section{Values: values}}}}
}

func (f *scriptedFetcher) fetch(ctx context.Context, _ types.ApplicationConfigSource, prior Validators) (FetchResult, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.priors = append(f.priors, prior)
	gate := f.gate
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return FetchResult{}, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.results) == 0 {
		return FetchResult{Document: &Document{}}, nil
	}
	next := f.results[0]
	if len(f.results) > 1 {
		f.results = f.results[1:]
	}
	return next.result, next.err
}

func (f *scriptedFetcher) setGate(gate chan struct{}) {
	f.mu.Lock()
	f.gate = gate
	f.mu.Unlock()
}

func newTestStore(t *testing.T, fetcher *scriptedFetcher, refresh time.Duration) *Store {
	t.Helper()
	store := NewStore(types.ApplicationConfigSource{Endpoint: "https://config.example.invalid"}, fetcher.fetch)
	store.refresh = refresh
	t.Cleanup(store.Stop)
	return store
}

// processView is the common-section view with no principal scoping.
func processView(store *Store) View {
	return store.Snapshot().View("", "")
}

func awaitState(t *testing.T, store *Store, subject string, want State) View {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if view := store.Snapshot().View(subject, ""); view.State == want {
			return view
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("state never reached %q; last %+v", want, store.Snapshot())
	return View{}
}

func TestStoreDeferredUntilPrincipalAvailable(t *testing.T) {
	fetcher := &scriptedFetcher{}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(nil, "initial")
	if view := processView(store); view.State != StateDeferred || view.Values != nil {
		t.Fatalf("no principal must stay deferred with no values: %+v", view)
	}
	if fetcher.calls.Load() != 0 {
		t.Fatalf("no principal must never fetch; calls=%d", fetcher.calls.Load())
	}
}

func TestStoreFetchingThenReady(t *testing.T) {
	fetcher := &scriptedFetcher{gate: make(chan struct{}), results: []fetchResult{commonDoc(map[string]any{"region": "east"})}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	if view := processView(store); view.State != StateFetching || view.Subject != "subject-a" {
		t.Fatalf("resolution in flight must read fetching for the principal: %+v", view)
	}
	if _, found, _ := processView(store).Lookup("region"); found {
		t.Fatal("a key must not be found before the snapshot is ready")
	}
	fetcher.gate <- struct{}{}
	view := awaitState(t, store, "", StateReady)
	if value, found, _ := view.Lookup("region"); !found || value != "east" {
		t.Fatalf("ready view must carry the resolved value: %+v", view)
	}
	if _, found, secret := view.Lookup("missing"); found || secret {
		t.Fatal("a ready view must report an absent key as not found")
	}
	if view.FetchedAt == "" {
		t.Fatal("ready view must record when it was fetched")
	}
}

func TestStoreFetchesOncePerIdentity(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{commonDoc(map[string]any{"k": "v"})}}
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
		commonDoc(map[string]any{"k": "v"}),
	}}
	store := newTestStore(t, fetcher, 10*time.Millisecond)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateFailed)
	if view := processView(store); view.Error != "endpoint returned status 503" || view.Values != nil {
		t.Fatalf("failed view must carry the reason and no values: %+v", view)
	}
	awaitState(t, store, "", StateReady)
}

func TestStoreSignOutPurgesAndDiscardsInFlight(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{commonDoc(map[string]any{"owner": "a-only"})}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateReady)

	store.applyIdentity(nil, "signed_out")
	if snap := store.Snapshot(); snap.State != StateDeferred || snap.Document != nil || snap.Subject != "" {
		t.Fatalf("sign-out must purge to deferred: %+v", snap)
	}

	// A resolution that completes after its identity was purged must not
	// resurrect the snapshot.
	fetcher.setGate(make(chan struct{}))
	store.applyIdentity(operatorA, "signed_in")
	store.mu.Lock()
	stale := store.generation
	store.mu.Unlock()
	store.applyIdentity(nil, "verification_lost")
	store.complete(stale, "subject-a", "entra", commonDoc(map[string]any{"owner": "a-only"}).result, nil)
	if snap := store.Snapshot(); snap.State != StateDeferred || snap.Document != nil {
		t.Fatalf("a purged generation's result must be discarded: %+v", snap)
	}
}

func TestStoreIdentitySwitchResolvesForNewPrincipal(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{
		commonDoc(map[string]any{"owner": "a"}),
		commonDoc(map[string]any{"owner": "b"}),
	}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	awaitState(t, store, "", StateReady)
	store.applyIdentity(operatorB, "signed_in")
	view := awaitState(t, store, "subject-b", StateReady)
	if view.Subject != "subject-b" || view.Values["owner"] != "b" {
		t.Fatalf("a new principal must get its own snapshot: %+v", view)
	}
	if other := store.Snapshot().View("subject-a", ""); other.State != StateDeferred || other.Values != nil {
		t.Fatalf("the previous principal must no longer see values: %+v", other)
	}
}

func TestStoreAwait(t *testing.T) {
	fetcher := &scriptedFetcher{gate: make(chan struct{}), results: []fetchResult{commonDoc(map[string]any{"k": "v"})}}
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
		if view := snap.View("", ""); view.State != StateReady || view.Values["k"] != "v" {
			t.Fatalf("await must return the ready snapshot: %+v", view)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("await never woke on readiness")
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
	fetcher := &scriptedFetcher{results: []fetchResult{commonDoc(map[string]any{"k": "v"})}}
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
	if view := Read("subject-a", "ext-a"); view.State != StateDisabled {
		t.Fatalf("an unconfigured engine must read disabled: %+v", view)
	}
	view, err := Await(context.Background(), "", "")
	if err != nil || view.State != StateDisabled {
		t.Fatalf("await on an unconfigured engine must return disabled at once: %+v %v", view, err)
	}
}
