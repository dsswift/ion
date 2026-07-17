package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/types"
)

// serverWithCodex builds a Server whose config selects codex for openai and
// whose probe registry reports an authenticated codex CLI.
func serverWithCodex(t *testing.T, authed bool) *Server {
	t.Helper()
	reg := cliprobe.NewRegistry()
	reg.SetProbeFunc(func(kind string) cliprobe.Probe {
		switch kind {
		case "codex":
			return cliprobe.Probe{Kind: "codex", Installed: true, BinaryPath: "/bin/codex", Version: "0.1", Authenticated: authed, AuthMethod: "chatgpt", PlanType: "pro", Email: "u@example.com", Label: "ChatGPT Pro"}
		default:
			return cliprobe.Probe{Kind: kind}
		}
	})
	reg.Refresh([]string{"codex", "claude-code", "grok", "cursor"})
	return &Server{
		authResolver: auth.NewResolver(nil),
		probes:       reg,
		config: &types.EngineRuntimeConfig{
			Backend: "hybrid",
			Providers: map[string]types.ProviderConfig{
				"openai": {Backend: "codex"},
			},
		},
	}
}

func findEntry(entries []types.ProviderEntry, id string) *types.ProviderEntry {
	for i := range entries {
		if entries[i].ID == id {
			return &entries[i]
		}
	}
	return nil
}

func TestBuildProviderEntries_CodexSelected_AuthedFromProbe(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OPENAI_API_KEY", "")
	s := serverWithCodex(t, true)
	entries := s.buildProviderEntries()

	openai := findEntry(entries, "openai")
	if openai == nil {
		t.Fatal("expected openai entry")
	}
	if openai.Backend != "codex" {
		t.Errorf("expected selected backend codex, got %q", openai.Backend)
	}
	if openai.Cli == nil || !openai.Cli.Installed || !openai.Cli.Authenticated {
		t.Fatalf("expected cli status installed+authed, got %+v", openai.Cli)
	}
	if openai.Cli.Label != "ChatGPT Pro" || openai.Cli.Email != "u@example.com" {
		t.Errorf("expected rich cli label/email, got %+v", openai.Cli)
	}
	if !openai.HasAuth || openai.AuthSource != "codex" {
		t.Errorf("expected hasAuth via codex, got hasAuth=%v authSource=%q", openai.HasAuth, openai.AuthSource)
	}
}

func TestBuildProviderEntries_CodexSelected_NotAuthed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OPENAI_API_KEY", "")
	s := serverWithCodex(t, false)
	entries := s.buildProviderEntries()

	openai := findEntry(entries, "openai")
	if openai == nil {
		t.Fatal("expected openai entry")
	}
	if openai.Cli == nil || openai.Cli.Authenticated {
		t.Fatalf("expected cli status not authed, got %+v", openai.Cli)
	}
	if openai.HasAuth && openai.AuthSource == "codex" {
		t.Errorf("expected no codex auth when the CLI is not authenticated")
	}
}

func TestBuildProviderEntries_CursorAppearsViaUnion(t *testing.T) {
	s := serverWithCodex(t, true)
	entries := s.buildProviderEntries()
	// cursor has no HTTP provider registration but must appear via the union.
	if findEntry(entries, "cursor") == nil {
		t.Fatal("expected cursor provider entry from the CLI-backed union")
	}
}

func TestProviderCliStatus_NoProbeYet(t *testing.T) {
	// Before a probe lands, cli status is nil but the selected backend is known.
	reg := cliprobe.NewRegistry() // empty, never refreshed
	s := &Server{
		probes: reg,
		config: &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"openai": {Backend: "codex"}}},
	}
	status, selected := s.providerCliStatus("openai")
	if status != nil {
		t.Errorf("expected nil cli status before probe, got %+v", status)
	}
	if selected != "codex" {
		t.Errorf("expected selected backend codex, got %q", selected)
	}
}
