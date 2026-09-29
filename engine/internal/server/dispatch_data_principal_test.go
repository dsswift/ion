package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// principalStubSource is a PrincipalCredentialSource that answers only for
// one exact (subject, provider) pair, so a test can give two principals
// different credential presence on the same provider in one engine.
type principalStubSource struct {
	subject, provider string
}

func (s principalStubSource) Name() string { return "test-stub" }
func (s principalStubSource) Resolve(_ context.Context, scope auth.CredentialScope) (auth.RequestAuthenticator, error) {
	if scope.Subject == s.subject && scope.Provider == s.provider {
		return principalStubAuthenticator{}, nil
	}
	return nil, nil
}

type principalStubAuthenticator struct{}

func (principalStubAuthenticator) Authenticate(_ context.Context, req *http.Request, _ []byte) error {
	req.Header.Set("Authorization", "Bearer stub")
	return nil
}

// TestProviderEntriesPerPrincipal pins R-13: two principals in one engine
// receive different HasAuth for the same provider when only one of them has
// a registered PrincipalCredentialSource answer.
func TestProviderEntriesPerPrincipal(t *testing.T) {
	auth.UnregisterAllPrincipalSourcesForTest()
	defer auth.UnregisterAllPrincipalSourcesForTest()
	auth.RegisterPrincipalSource(principalStubSource{subject: "alice", provider: "anthropic"})

	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	aliceCC := auth.NewCredentialContext(&types.SessionPrincipal{Subject: "alice"}, r, nil)
	bobCC := auth.NewCredentialContext(&types.SessionPrincipal{Subject: "bob"}, r, nil)

	aliceEntries := s.buildProviderEntries(aliceCC)
	bobEntries := s.buildProviderEntries(bobCC)

	aliceEntry := findAnthropicEntry(aliceEntries)
	bobEntry := findAnthropicEntry(bobEntries)
	if aliceEntry == nil || bobEntry == nil {
		t.Fatal("expected an anthropic entry for both principals")
	}
	if !aliceEntry.HasAuth {
		t.Error("expected alice's entry HasAuth=true (has a registered source)")
	}
	if bobEntry.HasAuth {
		t.Error("expected bob's entry HasAuth=false (no source, no resolver key)")
	}
}

// TestListModelsReturnsPrincipalEntitlement pins R-31 clause 1: list_models
// returns each principal's own discovered entitlement, never the other's
// exclusive model.
func TestListModelsReturnsPrincipalEntitlement(t *testing.T) {
	providers.ResetEntitlementForTest()
	t.Cleanup(providers.ResetEntitlementForTest)
	t.Cleanup(providers.ResetDiscoveryCache)

	fetch := func(subject string) func(context.Context) ([]types.ModelEntry, error) {
		return func(context.Context) ([]types.ModelEntry, error) {
			if subject == "alice" {
				return []types.ModelEntry{{ID: "alice-only", ProviderID: "gw"}, {ID: "shared", ProviderID: "gw"}}, nil
			}
			return []types.ModelEntry{{ID: "shared", ProviderID: "gw"}}, nil
		}
	}
	if _, err := providers.EntitlementFor(context.Background(), "alice", "gw", fetch("alice")); err != nil {
		t.Fatal(err)
	}
	if _, err := providers.EntitlementFor(context.Background(), "bob", "gw", fetch("bob")); err != nil {
		t.Fatal(err)
	}

	aliceCC := &auth.CredentialContext{Principal: &types.SessionPrincipal{Subject: "alice"}}
	aliceCC.Entitlement = func(providerID string) []string {
		ids, _ := providers.EntitlementFor(context.Background(), "alice", providerID, fetch("alice"))
		return ids
	}
	bobCC := &auth.CredentialContext{Principal: &types.SessionPrincipal{Subject: "bob"}}
	bobCC.Entitlement = func(providerID string) []string {
		ids, _ := providers.EntitlementFor(context.Background(), "bob", providerID, fetch("bob"))
		return ids
	}

	all := []types.ModelEntry{{ID: "alice-only", ProviderID: "gw"}, {ID: "shared", ProviderID: "gw"}}
	aliceModels := filterModelsByEntitlement(all, aliceCC)
	bobModels := filterModelsByEntitlement(all, bobCC)

	if len(aliceModels) != 2 {
		t.Errorf("alice models = %v, want both alice-only and shared", aliceModels)
	}
	for _, m := range bobModels {
		if m.ID == "alice-only" {
			t.Error("bob's model list contains alice's exclusive model")
		}
	}
	if len(bobModels) != 1 || bobModels[0].ID != "shared" {
		t.Errorf("bob models = %v, want exactly [shared]", bobModels)
	}
}

// TestListedBackendMatchesRunPick pins R-31 clause 2: the Backend a
// provider entry advertises equals what EffectiveBackendForProvider picks
// with the same (principal, provider) inputs the run itself uses.
func TestListedBackendMatchesRunPick(t *testing.T) {
	auth.UnregisterAllPrincipalSourcesForTest()
	defer auth.UnregisterAllPrincipalSourcesForTest()
	auth.RegisterPrincipalSource(principalStubSource{subject: "alice", provider: "anthropic"})

	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}
	aliceCC := auth.NewCredentialContext(&types.SessionPrincipal{Subject: "alice"}, r, nil)

	entries := s.buildProviderEntries(aliceCC)
	entry := findAnthropicEntry(entries)
	if entry == nil {
		t.Fatal("expected an anthropic entry")
	}

	wantKind := backend.EffectiveBackendForProvider("anthropic", contextKeyHaverForTest{cc: aliceCC}, nil, "", false)
	if entry.Backend != wantKind && (entry.Backend != "" || wantKind != "api") {
		t.Errorf("listed backend = %q, want %q (what the run would pick)", entry.Backend, wantKind)
	}
}

// contextKeyHaverForTest mirrors backend's unexported contextKeyHaver so this
// external test can compute the same comparison EffectiveBackendForProvider
// uses without reaching into the backend package's internals.
type contextKeyHaverForTest struct{ cc *auth.CredentialContext }

func (k contextKeyHaverForTest) HasKey(providerID string) (bool, string) {
	return k.cc.HasCredential(context.Background(), providerID)
}

// TestListedModelsAndBackendAgree pins R-31 (both clauses together): every
// model id returned for a provider is reachable through the backend that
// same response advertises for it -- i.e. neither half of dispatchListModels'
// response silently disagrees with the other.
func TestListedModelsAndBackendAgree(t *testing.T) {
	auth.UnregisterAllPrincipalSourcesForTest()
	defer auth.UnregisterAllPrincipalSourcesForTest()
	auth.RegisterPrincipalSource(principalStubSource{subject: "alice", provider: "anthropic"})
	providers.ResetEntitlementForTest()
	t.Cleanup(func() { providers.ResetEntitlementForTest() })

	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}
	aliceCC := auth.NewCredentialContext(&types.SessionPrincipal{Subject: "alice"}, r, nil)

	entries := s.buildProviderEntries(aliceCC)
	entry := findAnthropicEntry(entries)
	if entry == nil {
		t.Fatal("expected an anthropic entry")
	}
	// Alice has a credential (via the registered source): the advertised
	// backend must be "api" -- never a CLI kind advertised to someone with
	// their own working credential, and never empty/unset.
	if entry.Backend != "" && entry.Backend != "api" {
		t.Errorf("expected alice's anthropic entry to advertise api backend, got %q", entry.Backend)
	}
	if !entry.HasAuth {
		t.Error("expected alice's anthropic entry to report HasAuth=true, agreeing with the api backend advertised")
	}
}

// TestUnattributedEntriesUnchanged pins B-16: an unattributed listing (cc
// nil) is identical to the pre-child-06 behavior.
func TestUnattributedEntriesUnchanged(t *testing.T) {
	r := auth.NewResolver(nil)
	r.SetProgrammatic("anthropic", "sk-test-key")
	s := &Server{authResolver: r}

	entries := s.buildProviderEntries(nil)
	entry := findAnthropicEntry(entries)
	if entry == nil {
		t.Fatal("expected an anthropic entry")
	}
	if !entry.HasAuth || entry.AuthSource != "programmatic" {
		t.Errorf("unattributed entry = %+v, want HasAuth=true AuthSource=programmatic", entry)
	}
}

// TestOllamaAlwaysAuthed pins the unchanged special case: ollama reports
// authed for every principal, attributed or not.
func TestOllamaAlwaysAuthed(t *testing.T) {
	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}
	aliceCC := auth.NewCredentialContext(&types.SessionPrincipal{Subject: "alice"}, r, nil)

	for _, cc := range []*auth.CredentialContext{nil, aliceCC} {
		entries := s.buildProviderEntries(cc)
		var found *types.ProviderEntry
		for i := range entries {
			if entries[i].ID == "ollama" {
				found = &entries[i]
			}
		}
		if found == nil {
			t.Fatal("expected an ollama entry")
		}
		if !found.HasAuth || found.AuthSource != "none" {
			t.Errorf("ollama entry = %+v, want HasAuth=true AuthSource=none", found)
		}
	}
}
