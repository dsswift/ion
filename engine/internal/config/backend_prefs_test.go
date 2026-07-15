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

func TestExplicitBackendPref_NoDefaultRule(t *testing.T) {
	// No config → no preference. The credential-based rule (backend package)
	// decides; this helper must NOT reintroduce a static default.
	if got := ExplicitBackendPref(nil, "anthropic"); got != "" {
		t.Errorf("expected empty pref for anthropic with no config, got %q", got)
	}
	if got := ExplicitBackendPref(nil, "cursor"); got != "" {
		t.Errorf("expected empty pref for cursor with no config, got %q", got)
	}
	// Explicit valid preference is returned verbatim.
	cfg := cfgWithProviderBackend("openai", "codex")
	if got := ExplicitBackendPref(cfg, "openai"); got != "codex" {
		t.Errorf("expected openai pref codex, got %q", got)
	}
	// Invalid preference is treated as no preference.
	bad := cfgWithProviderBackend("openai", "grok") // grok is xai-only
	if got := ExplicitBackendPref(bad, "openai"); got != "" {
		t.Errorf("expected invalid pref to yield empty, got %q", got)
	}
}

func TestApiBackendAllowed(t *testing.T) {
	for pid, want := range map[string]bool{
		"anthropic": true,  // api or claude-code
		"openai":    true,  // api or codex
		"cursor":    false, // CLI-only
		"google":    true,  // no entry → api-only
	} {
		if got := ApiBackendAllowed(pid); got != want {
			t.Errorf("%s: expected ApiBackendAllowed=%v, got %v", pid, want, got)
		}
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
