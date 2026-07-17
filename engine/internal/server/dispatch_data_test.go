package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// findAnthropicEntry is a test helper that locates the "anthropic" provider
// in the slice returned by buildProviderEntries.
func findAnthropicEntry(entries []types.ProviderEntry) *types.ProviderEntry {
	for i := range entries {
		if entries[i].ID == "anthropic" {
			return &entries[i]
		}
	}
	return nil
}

func TestBuildProviderEntries_CliCapable_NoApiKey(t *testing.T) {
	// Server is CLI-capable and the resolver has no key for anthropic, so the
	// claude-code auth fallback marks anthropic as authed via "claude-code"
	// (the canonical wire value; it was "cli" before the backend rename, so
	// this assertion is red on unfixed code).
	//
	// Isolate HOME (filestore / credentials.json / oauth all resolve under
	// ~/.ion) and unset the env keys so the fallback is actually reachable.
	// On a dev machine with a real keychain anthropic entry the resolver
	// would return "keychain" first; CI runs clean, so equality holds there.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "")
	r := auth.NewResolver(nil)
	s := &Server{
		cliCapable:   true,
		authResolver: r,
	}
	entries := s.buildProviderEntries()

	entry := findAnthropicEntry(entries)
	if entry == nil {
		t.Fatal("expected anthropic provider entry in result")
	}
	if !entry.HasAuth {
		t.Errorf("expected HasAuth=true for CLI-capable anthropic, got false")
	}
	// The fallback source must be the canonical "claude-code", never the
	// legacy "cli". Only assert exact equality when no host credential
	// short-circuited the resolver (keychain on a dev laptop).
	if entry.AuthSource == "cli" {
		t.Errorf("fallback emitted legacy %q; expected canonical %q", "cli", "claude-code")
	}
	if entry.AuthSource != "keychain" && entry.AuthSource != "claude-code" {
		t.Errorf("expected AuthSource=claude-code (or keychain on a dev host), got %q", entry.AuthSource)
	}
}

func TestBuildProviderEntries_NotCliCapable(t *testing.T) {
	// Server is NOT CLI-capable. Anthropic should NOT have "claude-code" as
	// its auth source, regardless of whether the host has credentials.
	r := auth.NewResolver(nil)
	s := &Server{
		cliCapable:   false,
		authResolver: r,
	}
	entries := s.buildProviderEntries()

	entry := findAnthropicEntry(entries)
	if entry == nil {
		t.Fatal("expected anthropic provider entry in result")
	}
	// The claude-code fallback must not fire when cliCapable=false.
	if entry.AuthSource == "claude-code" {
		t.Errorf("expected AuthSource != %q when cliCapable=false, got %q", "claude-code", entry.AuthSource)
	}
}

func TestBuildProviderEntries_CliCapable_WithApiKey(t *testing.T) {
	// Server is CLI-capable but the resolver already has a key for
	// anthropic via the programmatic level. The resolver's source should
	// win (CLI fallback only fires when !entry.HasAuth).
	r := auth.NewResolver(nil)
	r.SetProgrammatic("anthropic", "sk-test-key")
	s := &Server{
		cliCapable:   true,
		authResolver: r,
	}
	entries := s.buildProviderEntries()

	entry := findAnthropicEntry(entries)
	if entry == nil {
		t.Fatal("expected anthropic provider entry in result")
	}
	if !entry.HasAuth {
		t.Errorf("expected HasAuth=true when programmatic key is set, got false")
	}
	if entry.AuthSource == "claude-code" {
		t.Errorf("expected AuthSource != %q when API key is already present, got %q", "claude-code", entry.AuthSource)
	}
	if entry.AuthSource != "programmatic" {
		t.Errorf("expected AuthSource=%q, got %q", "programmatic", entry.AuthSource)
	}
}
