package appconfig

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestStoreFollowsOperatorSignInAndSignOut drives the store through the real
// operator identity manager: the grant present at Start is resolved without
// any extension asking, and SignOut's published transition purges it.
func TestStoreFollowsOperatorSignInAndSignOut(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := auth.NewIdentityManager("entra", types.OAuthConfig{
		ClientID: "client-1", AuthorizationURL: "https://login.example.com/authorize", TokenURL: "https://login.example.com/token",
	}, 0)
	err := manager.SeedVerifiedLoginForTest(
		&auth.TokenResponse{AccessToken: "at", RefreshToken: "rt", ExpiresAt: time.Now().Add(time.Hour)},
		&auth.OperatorIdentity{Subject: "subject-a", Username: "user@example.com"},
	)
	if err != nil {
		t.Fatalf("seed grant: %v", err)
	}
	auth.SetOperator(manager)
	t.Cleanup(func() { auth.SetOperator(nil) })

	fetcher := &scriptedFetcher{results: []fetchResult{{values: map[string]any{"k": "v"}}}}
	store := newTestStore(t, fetcher, time.Hour)
	store.Start()
	snap := awaitState(t, store, "", StateReady)
	if snap.Subject != "subject-a" || snap.Provider != "entra" {
		t.Fatalf("the signed-in operator must be resolved at start: %+v", snap)
	}

	if err := manager.SignOut(); err != nil {
		t.Fatalf("sign out: %v", err)
	}
	purged := awaitState(t, store, "", StateDeferred)
	if purged.Values != nil || purged.Subject != "" {
		t.Fatalf("sign-out must purge the snapshot: %+v", purged)
	}
	if calls := fetcher.calls.Load(); calls != 1 {
		t.Fatalf("one identity must produce one fetch; calls=%d", calls)
	}
}
