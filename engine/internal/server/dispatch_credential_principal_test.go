package server

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestStoreCredential_PartitionedByPrincipal pins R-37: a store_credential
// from alice's connection is invisible to bob's own resolution, even though
// both share the same underlying credentials.enc file.
func TestStoreCredential_PartitionedByPrincipal(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	s.dispatch(nil, &protocol.ClientCommand{
		Cmd: "store_credential", Provider: "anthropic", Credential: "sk-alice",
		Principal: &types.SessionPrincipal{Subject: "alice"},
	})

	fs := auth.NewFileStore()
	if got, err := fs.GetKeyFor("alice", "anthropic"); err != nil || got != "sk-alice" {
		t.Fatalf("alice's own read = (%q, %v), want (sk-alice, nil)", got, err)
	}
	if _, err := fs.GetKeyFor("bob", "anthropic"); err == nil {
		t.Error("expected bob's read of alice's stored credential to fail")
	}
	if _, err := fs.GetKey("anthropic"); err == nil {
		t.Error("expected the unattributed read to fail -- the credential is alice's, not the process's")
	}
}

// TestStoreCredential_DeleteScopedToPrincipal pins R-37: clearing (empty
// credential) from bob's connection never deletes alice's stored credential
// for the same provider.
func TestStoreCredential_DeleteScopedToPrincipal(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	fs := auth.NewFileStore()
	if err := fs.SetKeyFor("alice", "anthropic", "sk-alice"); err != nil {
		t.Fatal(err)
	}

	s.dispatch(nil, &protocol.ClientCommand{
		Cmd: "store_credential", Provider: "anthropic", Credential: "",
		Principal: &types.SessionPrincipal{Subject: "bob"},
	})

	if got, err := fs.GetKeyFor("alice", "anthropic"); err != nil || got != "sk-alice" {
		t.Errorf("alice's credential should survive bob's delete, got (%q, %v)", got, err)
	}
}

// TestStoreCredential_UnattributedUnchanged pins B-07..B-10: a
// store_credential with no principal writes exactly where it always did --
// the unattributed (unpartitioned) key.
func TestStoreCredential_UnattributedUnchanged(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	s.dispatch(nil, &protocol.ClientCommand{
		Cmd: "store_credential", Provider: "anthropic", Credential: "sk-unattributed",
	})

	fs := auth.NewFileStore()
	if got, err := fs.GetKey("anthropic"); err != nil || got != "sk-unattributed" {
		t.Fatalf("unattributed read = (%q, %v), want (sk-unattributed, nil)", got, err)
	}
}

// TestStoreCredentialTriggersDiscovery pins B-11/B-12: an unattributed
// store_credential still triggers model discovery for the newly-authed
// provider with no restart, unaffected by the principal-partitioning change.
func TestStoreCredentialTriggersDiscovery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	providers.ResetDiscoveryCache()
	t.Cleanup(providers.ResetDiscoveryCache)

	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	s.dispatch(nil, &protocol.ClientCommand{
		Cmd: "store_credential", Provider: "anthropic", Credential: "sk-test",
	})

	// DiscoverProvider runs its HTTP fetch in a goroutine, so the discovery
	// cache entry may not exist the instant dispatch returns. Poll briefly
	// (bounded, not a flaky fixed sleep) rather than assert on discovery's
	// OUTCOME, which would depend on a fake key actually authenticating.
	deadline := time.Now().Add(2 * time.Second)
	for !providers.HasDiscoveryEntryForTest("anthropic") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !providers.HasDiscoveryEntryForTest("anthropic") {
		t.Error("expected an unattributed store_credential to trigger discovery for the provider")
	}
}
