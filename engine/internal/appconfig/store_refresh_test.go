package appconfig

import (
	"errors"
	"testing"
	"time"
)

// startRefresh runs one refresh cycle the way the store's loop does, with
// the fetch held on a gate so the test can observe the refreshing state.
func startRefresh(t *testing.T, store *Store, fetcher *scriptedFetcher, prior Validators) (release func(), done <-chan bool) {
	t.Helper()
	gate := make(chan struct{})
	fetcher.setGate(gate)
	store.mu.Lock()
	generation := store.generation
	store.mu.Unlock()
	finished := make(chan bool, 1)
	callsBefore := fetcher.calls.Load()
	go func() {
		if !store.beginRefresh(generation) {
			finished <- false
			return
		}
		result, err := store.fetch(t.Context(), store.source, prior)
		finished <- store.complete(generation, "subject-a", "entra", result, err)
	}()
	for fetcher.calls.Load() == callsBefore {
		time.Sleep(time.Millisecond)
	}
	return func() { gate <- struct{}{} }, finished
}

func TestStoreRefreshIsAtomicAndVisible(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{
		commonDoc(map[string]any{"old": 1.0, "shared": "first"}),
		commonDoc(map[string]any{"shared": "second"}),
	}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	first := awaitState(t, store, "", StateReady)

	release, done := startRefresh(t, store, fetcher, Validators{})
	during := processView(store)
	if during.State != StateRefreshing || during.Revision != first.Revision+1 || during.Values["old"] != 1.0 {
		t.Fatalf("readers must see refreshing with the previous values during refresh: %+v", during)
	}
	if value, found, _ := during.Lookup("shared"); !found || value != "first" {
		t.Fatalf("a key must stay readable while refreshing: %v %v", value, found)
	}
	release()
	if !<-done {
		t.Fatal("a successful refresh must report its document installed")
	}
	next := processView(store)
	if next.State != StateReady || next.Revision != first.Revision+2 || next.Values["shared"] != "second" {
		t.Fatalf("refresh must install the next snapshot: %+v", next)
	}
	if _, found, _ := next.Lookup("old"); found {
		t.Fatalf("refresh must replace the snapshot whole, never merge: %+v", next.Values)
	}
}

func TestStoreRefreshFailureKeepsPreviousSnapshot(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{
		commonDoc(map[string]any{"k": "v"}),
		{err: errors.New("timeout")},
	}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	ready := awaitState(t, store, "", StateReady)
	release, done := startRefresh(t, store, fetcher, Validators{})
	release()
	if <-done {
		t.Fatal("a failed refresh must not report a document installed")
	}
	after := processView(store)
	if after.State != StateReady || after.Values["k"] != "v" || after.FetchedAt != ready.FetchedAt {
		t.Fatalf("a failed refresh must return to ready with the previous snapshot: %+v", after)
	}
}

func TestStoreRefreshNotModifiedKeepsDocument(t *testing.T) {
	validators := Validators{ETag: `"v1"`, LastModified: "Tue, 29 Sep 2026 10:00:00 GMT"}
	fetcher := &scriptedFetcher{results: []fetchResult{
		{result: FetchResult{Document: &Document{Common: Section{Values: map[string]any{"k": "v"}}}, Validators: validators}},
		{result: FetchResult{NotModified: true, Validators: validators}},
	}}
	store := newTestStore(t, fetcher, 10*time.Millisecond)
	store.applyIdentity(operatorA, "signed_in")
	ready := awaitState(t, store, "", StateReady)

	// The loop's next refresh must send back the first document's
	// validators, and a 304 must keep that document.
	deadline := time.Now().Add(2 * time.Second)
	for fetcher.calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	fetcher.mu.Lock()
	priors := append([]Validators(nil), fetcher.priors...)
	fetcher.mu.Unlock()
	if len(priors) < 2 || priors[0] != (Validators{}) || priors[1] != validators {
		t.Fatalf("first fetch must be unconditional and the refresh conditional: %+v", priors)
	}
	after := awaitState(t, store, "", StateReady)
	if after.Values["k"] != "v" || after.FetchedAt != ready.FetchedAt {
		t.Fatalf("a not-modified refresh must keep the document: %+v", after)
	}
}

func TestStoreNotModifiedWithoutDocumentFails(t *testing.T) {
	fetcher := &scriptedFetcher{results: []fetchResult{{result: FetchResult{NotModified: true}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.applyIdentity(operatorA, "signed_in")
	view := awaitState(t, store, "", StateFailed)
	if view.Error == "" {
		t.Fatalf("not modified with no prior document must fail with a reason: %+v", view)
	}
}
