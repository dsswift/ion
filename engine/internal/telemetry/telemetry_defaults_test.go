package telemetry

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestNormalize_EnabledNoTargetsNoPath covers the primary ergonomic use-case:
// an operator sets only {"telemetry":{"enabled":true}} with no targets or
// filePath. The engine must default to the file target at
// ~/.ion/telemetry.jsonl (tilde-expanded to the real home directory).
func TestNormalize_EnabledNoTargetsNoPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Verify the HOME override is honoured before we rely on it.
	resolvedHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if resolvedHome != home {
		t.Skipf("HOME override not honoured on this platform (got %q, want %q)", resolvedHome, home)
	}

	cfg := normalizeTelemetryConfig(types.TelemetryConfig{
		Enabled: true,
		// Targets and FilePath intentionally left zero-value.
	})

	// Targets must default to ["file"].
	if len(cfg.Targets) != 1 || cfg.Targets[0] != "file" {
		t.Errorf("Targets = %v, want [\"file\"]", cfg.Targets)
	}

	// FilePath must be expanded — not the literal "~/" string.
	if strings.HasPrefix(cfg.FilePath, "~") {
		t.Errorf("FilePath = %q: tilde was not expanded", cfg.FilePath)
	}
	if !filepath.IsAbs(cfg.FilePath) {
		t.Errorf("FilePath = %q: expected an absolute path", cfg.FilePath)
	}

	want := filepath.Join(home, ".ion", "telemetry.jsonl")
	if cfg.FilePath != want {
		t.Errorf("FilePath = %q, want %q", cfg.FilePath, want)
	}
}

// TestNormalize_EnabledHTTPTargetNoPath checks that when the operator sets
// targets: ["http"] and no filePath, the engine does NOT inject a file target
// and does NOT set a filePath. HTTP-only deployments stay HTTP-only.
func TestNormalize_EnabledHTTPTargetNoPath(t *testing.T) {
	cfg := normalizeTelemetryConfig(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"http"},
		// FilePath intentionally left empty.
	})

	if len(cfg.Targets) != 1 || cfg.Targets[0] != "http" {
		t.Errorf("Targets = %v, want [\"http\"]", cfg.Targets)
	}
	if cfg.FilePath != "" {
		t.Errorf("FilePath = %q, want empty (no file target was set)", cfg.FilePath)
	}
}

// TestNormalize_EnabledFileTargetExplicitPath checks that when the operator
// sets targets: ["file"] with an explicit filePath, both are left unchanged.
// The default must never override an explicitly-configured value.
func TestNormalize_EnabledFileTargetExplicitPath(t *testing.T) {
	const customPath = "/custom/path/telemetry.jsonl"

	cfg := normalizeTelemetryConfig(types.TelemetryConfig{
		Enabled:  true,
		Targets:  []string{"file"},
		FilePath: customPath,
	})

	if len(cfg.Targets) != 1 || cfg.Targets[0] != "file" {
		t.Errorf("Targets = %v, want [\"file\"]", cfg.Targets)
	}
	if cfg.FilePath != customPath {
		t.Errorf("FilePath = %q, want %q (explicit path must not be overridden)", cfg.FilePath, customPath)
	}
}

// TestNormalize_DisabledAllEmpty checks that when Enabled is false, the config
// is returned completely unchanged regardless of whether other fields are zero.
// The collector is a no-op when disabled; injecting defaults would be wrong.
func TestNormalize_DisabledAllEmpty(t *testing.T) {
	in := types.TelemetryConfig{
		Enabled:  false,
		Targets:  nil,
		FilePath: "",
	}
	out := normalizeTelemetryConfig(in)

	if out.Enabled {
		t.Error("Enabled changed: was false, got true")
	}
	if len(out.Targets) != 0 {
		t.Errorf("Targets = %v, want nil/empty (disabled must not inject defaults)", out.Targets)
	}
	if out.FilePath != "" {
		t.Errorf("FilePath = %q, want empty (disabled must not inject defaults)", out.FilePath)
	}
}
