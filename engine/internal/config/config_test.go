package config

import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected defaultModel=claude-sonnet-4-6, got %q", cfg.DefaultModel)
	}
	// Engine ships without opinionated limits; harness/operator sets them.
	if cfg.Limits.MaxTurns != nil {
		t.Fatalf("expected MaxTurns=nil (unlimited), got %v", *cfg.Limits.MaxTurns)
	}
	if cfg.Limits.MaxBudgetUsd != nil {
		t.Fatalf("expected MaxBudgetUsd=nil (unlimited), got %v", *cfg.Limits.MaxBudgetUsd)
	}
}

func TestDefaultConfig_McpServersInitialized(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.McpServers == nil {
		t.Fatal("expected McpServers map to be initialized")
	}
	if len(cfg.McpServers) != 0 {
		t.Fatalf("expected empty McpServers map, got %d entries", len(cfg.McpServers))
	}
}

func TestDefaultConfig_ProvidersInitialized(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Providers == nil {
		t.Fatal("expected Providers map to be initialized")
	}
	if len(cfg.Providers) != 0 {
		t.Fatalf("expected empty Providers map, got %d entries", len(cfg.Providers))
	}
}

func TestDefaultConfig_ProfilesNil(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Profiles != nil {
		t.Fatal("expected Profiles to be nil by default")
	}
}

func TestDefaultConfig_OptionalFieldsNil(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Permissions != nil {
		t.Fatal("expected Permissions to be nil")
	}
	if cfg.Auth != nil {
		t.Fatal("expected Auth to be nil")
	}
	if cfg.Network != nil {
		t.Fatal("expected Network to be nil")
	}
	if cfg.Telemetry != nil {
		t.Fatal("expected Telemetry to be nil")
	}
	if cfg.Compaction != nil {
		t.Fatal("expected Compaction to be nil")
	}
	if cfg.Enterprise != nil {
		t.Fatal("expected Enterprise to be nil")
	}
}

// ---------------------------------------------------------------------------
// ExpandTilde
// ---------------------------------------------------------------------------

func TestExpandTilde(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot determine home dir")
	}

	tests := []struct {
		input string
		want  string
	}{
		{"~/foo/bar", home + "/foo/bar"},
		{"~", home},
		{"/absolute/path", "/absolute/path"},
		{"relative/path", "relative/path"},
		{"", ""},
	}

	for _, tt := range tests {
		got := ExpandTilde(tt.input)
		if got != tt.want {
			t.Errorf("ExpandTilde(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestExpandTilde_TildeInMiddle(t *testing.T) {
	// Tilde only expanded when it is the first character
	got := ExpandTilde("/some/~path")
	if got != "/some/~path" {
		t.Errorf("expected /some/~path unchanged, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// FindProfile
// ---------------------------------------------------------------------------

func TestFindProfile(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Profiles: []types.EngineProfileConfig{
			{ID: "p1", Name: "default"},
			{ID: "p2", Name: "work"},
		},
	}

	tests := []struct {
		query string
		want  string
	}{
		{"default", "p1"},
		{"work", "p2"},
		{"p1", "p1"},
		{"p2", "p2"},
		{"missing", ""},
	}

	for _, tt := range tests {
		p := FindProfile(tt.query, cfg)
		if tt.want == "" {
			if p != nil {
				t.Errorf("FindProfile(%q) expected nil, got %v", tt.query, p)
			}
			continue
		}
		if p == nil {
			t.Errorf("FindProfile(%q) returned nil, expected ID=%q", tt.query, tt.want)
			continue
		}
		if p.ID != tt.want {
			t.Errorf("FindProfile(%q).ID = %q, want %q", tt.query, p.ID, tt.want)
		}
	}
}

func TestFindProfile_NilConfig(t *testing.T) {
	if p := FindProfile("test", nil); p != nil {
		t.Fatal("expected nil for nil config")
	}
}

func TestFindProfile_EmptyProfiles(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{Profiles: []types.EngineProfileConfig{}}
	if p := FindProfile("anything", cfg); p != nil {
		t.Fatal("expected nil for empty profiles slice")
	}
}

func TestFindProfile_EmptyQuery(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Profiles: []types.EngineProfileConfig{
			{ID: "p1", Name: "default"},
		},
	}
	if p := FindProfile("", cfg); p != nil {
		t.Fatal("expected nil for empty query string")
	}
}

// ---------------------------------------------------------------------------
// MergeConfigs
// ---------------------------------------------------------------------------

func TestFromMap_NilInput(t *testing.T) {
	result := fromMap(nil)
	if result != nil {
		t.Fatal("expected nil for nil input")
	}
}

func TestFromMap_ValidInput(t *testing.T) {
	m := map[string]any{
		"backend":      "cli",
		"defaultModel": "test-model",
		"limits": map[string]any{
			"maxTurns": float64(100),
		},
	}
	result := fromMap(m)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Backend != "cli" {
		t.Fatalf("expected backend=cli, got %q", result.Backend)
	}
	if result.DefaultModel != "test-model" {
		t.Fatalf("expected test-model, got %q", result.DefaultModel)
	}
	if result.Limits.MaxTurns == nil || *result.Limits.MaxTurns != 100 {
		t.Fatalf("expected maxTurns=100, got %v", result.Limits.MaxTurns)
	}
}

func TestFromMap_EmptyMap(t *testing.T) {
	result := fromMap(map[string]any{})
	if result == nil {
		t.Fatal("expected non-nil result for empty map")
	}
}

func TestFromMap_UnknownFieldsIgnored(t *testing.T) {
	m := map[string]any{
		"backend":      "api",
		"unknownField": "should be ignored",
	}
	result := fromMap(m)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", result.Backend)
	}
}

// ---------------------------------------------------------------------------
// loadJSONConfig
// ---------------------------------------------------------------------------

func TestContains(t *testing.T) {
	tests := []struct {
		name  string
		slice []string
		item  string
		want  bool
	}{
		{"found", []string{"a", "b", "c"}, "b", true},
		{"not found", []string{"a", "b", "c"}, "d", false},
		{"empty slice", []string{}, "a", false},
		{"nil slice", nil, "a", false},
		{"single match", []string{"x"}, "x", true},
		{"single no match", []string{"x"}, "y", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := contains(tt.slice, tt.item); got != tt.want {
				t.Errorf("contains(%v, %q) = %v, want %v", tt.slice, tt.item, got, tt.want)
			}
		})
	}
}
