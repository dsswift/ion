package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func cfgWithProviderBackend(pid, backend string) *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			pid: {Backend: backend},
		},
	}
}

func TestValidateProviderBackends_AllowedValuesKept(t *testing.T) {
	cases := map[string]string{
		"anthropic": "claude-code",
		"openai":    "codex",
		"xai":       "grok",
		"cursor":    "cursor",
	}
	for pid, backend := range cases {
		cfg := cfgWithProviderBackend(pid, backend)
		validateProviderBackends(cfg)
		if got := cfg.Providers[pid].Backend; got != backend {
			t.Errorf("%s: expected valid backend %q to be kept, got %q", pid, backend, got)
		}
	}
}

func TestValidateProviderBackends_ApiAlwaysAllowed(t *testing.T) {
	for _, pid := range []string{"anthropic", "openai", "xai", "google", "mistral"} {
		cfg := cfgWithProviderBackend(pid, "api")
		validateProviderBackends(cfg)
		if got := cfg.Providers[pid].Backend; got != "api" {
			t.Errorf("%s: expected api to be allowed, got %q", pid, got)
		}
	}
}

func TestValidateProviderBackends_InvalidResetToDefault(t *testing.T) {
	// A provider pinned to a backend it cannot use must reset to "" (default
	// rule), not silently keep the bad value.
	cases := map[string]string{
		"anthropic": "codex",       // codex is openai-only
		"openai":    "claude-code", // claude-code is anthropic-only
		"google":    "codex",       // google has no CLI backend
		"cursor":    "api",         // cursor has no API mode
	}
	for pid, bad := range cases {
		cfg := cfgWithProviderBackend(pid, bad)
		validateProviderBackends(cfg)
		if got := cfg.Providers[pid].Backend; got != "" {
			t.Errorf("%s: expected invalid backend %q to reset to default, got %q", pid, bad, got)
		}
	}
}

func TestProviderBackendPrefs_OnlyExplicitEntries(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"openai":    {Backend: "codex"},
			"anthropic": {Backend: ""}, // default rule → omitted
			"xai":       {Backend: "grok"},
		},
	}
	prefs := ProviderBackendPrefs(cfg)
	if len(prefs) != 2 {
		t.Fatalf("expected 2 explicit prefs, got %d (%v)", len(prefs), prefs)
	}
	if prefs["openai"] != "codex" || prefs["xai"] != "grok" {
		t.Fatalf("unexpected prefs map: %v", prefs)
	}
	if _, ok := prefs["anthropic"]; ok {
		t.Fatalf("default-rule provider should be omitted from prefs, got %v", prefs)
	}
}

func TestCliBackendKind(t *testing.T) {
	for pid, want := range map[string]string{"anthropic": "claude-code", "openai": "codex", "xai": "grok", "cursor": "cursor"} {
		if got, ok := CliBackendKind(pid); !ok || got != want {
			t.Errorf("%s: expected cli kind %q, got %q ok=%v", pid, want, got, ok)
		}
	}
	if _, ok := CliBackendKind("google"); ok {
		t.Error("expected google to have no cli backend")
	}
}

func TestSelectedBackend_DefaultRuleAndPref(t *testing.T) {
	// Default rule (no config): anthropic → claude-code, cursor → cursor, else api.
	if got := SelectedBackend(nil, "anthropic"); got != "claude-code" {
		t.Errorf("expected anthropic default claude-code, got %q", got)
	}
	if got := SelectedBackend(nil, "cursor"); got != "cursor" {
		t.Errorf("expected cursor default cursor, got %q", got)
	}
	if got := SelectedBackend(nil, "openai"); got != "api" {
		t.Errorf("expected openai default api, got %q", got)
	}
	// Explicit valid preference wins.
	cfg := cfgWithProviderBackend("openai", "codex")
	if got := SelectedBackend(cfg, "openai"); got != "codex" {
		t.Errorf("expected openai pref codex, got %q", got)
	}
	// Invalid preference falls back to the default rule.
	bad := cfgWithProviderBackend("openai", "grok") // grok is xai-only
	if got := SelectedBackend(bad, "openai"); got != "api" {
		t.Errorf("expected invalid pref to fall back to api, got %q", got)
	}
}

func TestProviderBackendPrefs_NoneReturnsNil(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{"openai": {Backend: ""}},
	}
	if prefs := ProviderBackendPrefs(cfg); prefs != nil {
		t.Fatalf("expected nil prefs when none configured, got %v", prefs)
	}
}
