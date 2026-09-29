package backend

import "testing"

// TestRefusedPrincipalIsNotRoutedToCli pins R-46: an attributed principal
// whose API path requires its own credential must never be routed to the
// machine's shared delegated-CLI subscription, even when that CLI is
// installed and authenticated. This test fails against the pre-fix router,
// which returns cliKind whenever no API key is present regardless of who is
// asking.
func TestRefusedPrincipalIsNotRoutedToCli(t *testing.T) {
	// No API key for anthropic; the CLI (claude-code) IS authed.
	keys := newFakeKeys() // no keys at all
	cliAuthed := func(string) bool { return true }

	requiresPrincipalCredential := true
	kind := EffectiveBackendForProvider("anthropic", keys, cliAuthed, "", requiresPrincipalCredential)
	if kind == "claude-code" {
		t.Fatalf("expected the refused principal NOT to be routed to the authed CLI, got %q", kind)
	}
	if kind != "api" {
		t.Errorf("expected the refused principal to route to api (where the refusal surfaces), got %q", kind)
	}
}

// TestRefusedPrincipalCliOnlyProviderStillRoutesToCli covers the CLI-only
// provider edge case documented on EffectiveBackendForProvider: even a
// refused principal routes to the CLI kind when the provider has no API
// backend at all, so the refusal surfaces as an ordinary provider-auth
// failure instead of a confusing "no provider" error.
func TestRefusedPrincipalCliOnlyProviderStillRoutesToCli(t *testing.T) {
	keys := newFakeKeys()
	cliAuthed := func(string) bool { return true }

	kind := EffectiveBackendForProvider("cursor", keys, cliAuthed, "", true)
	if kind != "cursor" {
		t.Errorf("expected a CLI-only provider to still route to its CLI kind even for a refused principal, got %q", kind)
	}
}

// TestUnattributedStillRoutesToCli pins B-15: an unattributed engine's
// existing behavior (no principal, no api key, cli authed -> cli) is
// unaffected by requiresPrincipalCredential=false.
func TestUnattributedStillRoutesToCli(t *testing.T) {
	keys := newFakeKeys()
	cliAuthed := func(string) bool { return true }

	kind := EffectiveBackendForProvider("anthropic", keys, cliAuthed, "", false)
	if kind != "claude-code" {
		t.Errorf("expected unattributed routing to the authed CLI (B-15), got %q", kind)
	}
}

// TestRequiredButApiKeyPresentStillRoutesApi proves the api-key-wins branch
// is unaffected by requiresPrincipalCredential: a principal WITH a resolved
// key (via KeyHaver) is never refused -- refusal is only for the no-source,
// no-fallback case.
func TestRequiredButApiKeyPresentStillRoutesApi(t *testing.T) {
	keys := newFakeKeys("anthropic")
	cliAuthed := func(string) bool { return true }

	kind := EffectiveBackendForProvider("anthropic", keys, cliAuthed, "", true)
	if kind != "api" {
		t.Errorf("expected api-key-present to win regardless of requiresPrincipalCredential, got %q", kind)
	}
}
