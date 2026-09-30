package appconfig

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func newSecretStore(t *testing.T, fetcher *scriptedFetcher) *Store {
	t.Helper()
	store := NewStore(types.ApplicationConfigSource{
		Endpoint: "https://config.example.invalid", SecretKeys: []string{"gatewayKey", "numericSecret"},
	}, fetcher.fetch)
	t.Cleanup(store.Stop)
	return store
}

// TestSecretKeysWithheldFromEveryView pins that a declared secret never
// appears in a snapshot, an await result, or a subscriber delivery, while
// the engine-internal read still returns it.
func TestSecretKeysWithheldFromEveryView(t *testing.T) {
	delivered := make(chan Snapshot, 16)
	unsubscribe := Subscribe(func(s Snapshot) { delivered <- s })
	t.Cleanup(unsubscribe)

	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"gatewayKey": "gk-secret", "endpoint": "https://erm.example.com"}}}}
	store := newSecretStore(t, fetcher)
	Install(store)
	t.Cleanup(func() { Install(nil) })
	store.applyIdentity(operatorA, "sign_in")

	ready := awaitState(t, store, "", StateReady)
	awaited, err := Await(context.Background(), operatorA.Subject)
	if err != nil {
		t.Fatalf("await: %v", err)
	}
	for name, snap := range map[string]Snapshot{"snapshot": ready, "await": awaited, "read": Read(operatorA.Subject)} {
		if _, leaked := snap.Values["gatewayKey"]; leaked || snap.Values["endpoint"] != "https://erm.example.com" {
			t.Fatalf("%s: secret must be withheld and plain values kept: %+v", name, snap.Values)
		}
	}
	deadline := time.After(2 * time.Second)
	for sawReady := false; !sawReady; {
		select {
		case snap := <-delivered:
			if _, leaked := snap.Values["gatewayKey"]; leaked {
				t.Fatalf("subscriber received the secret: %+v", snap.Values)
			}
			sawReady = snap.State == StateReady
		case <-deadline:
			t.Fatal("no ready delivery")
		}
	}

	got, err := ReadSecret(operatorA.Subject, "gatewayKey")
	if err != nil || got != "gk-secret" {
		t.Fatalf("ReadSecret = %q, %v", got, err)
	}
}

// TestReadSecretDistinguishesConditions pins each failure as its own error.
func TestReadSecretDistinguishesConditions(t *testing.T) {
	Install(nil)
	if _, err := ReadSecret("", "gatewayKey"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("no store: %v", err)
	}

	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"endpoint": "x", "numericSecret": 42.0}}}}
	store := newSecretStore(t, fetcher)
	Install(store)
	t.Cleanup(func() { Install(nil) })
	store.applyIdentity(nil, "initial")
	var notReady NotReadyError
	if _, err := ReadSecret("", "gatewayKey"); !errors.As(err, &notReady) || notReady.State != StateDeferred {
		t.Fatalf("deferred: %v", err)
	}

	store.applyIdentity(operatorA, "sign_in")
	awaitState(t, store, "", StateReady)
	if _, err := ReadSecret(operatorA.Subject, "endpoint"); !errors.Is(err, ErrNotSecret) {
		t.Fatalf("undeclared key: %v", err)
	}
	if _, err := ReadSecret(operatorA.Subject, "gatewayKey"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing key: %v", err)
	}
	if _, err := ReadSecret(operatorA.Subject, "numericSecret"); err == nil {
		t.Fatal("a non-string secret must be refused")
	}
	if _, err := ReadSecret(operatorB.Subject, "gatewayKey"); !errors.As(err, &notReady) {
		t.Fatalf("another principal must read deferred: %v", err)
	}
}
