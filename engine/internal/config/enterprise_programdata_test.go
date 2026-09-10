package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestReadProgramDataDir exercises the ProgramData layout: main file, drop-in
// byte-order merge, and the absent-root case.
func TestReadProgramDataDir(t *testing.T) {
	t.Run("main file only", func(t *testing.T) {
		root := t.TempDir()
		writeProgramDataFile(t, root, "Ion/enterprise-config.json", `{"allowedModels":["a"]}`)

		cfg, reports := readProgramDataDir(root)
		if cfg == nil || len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "a" {
			t.Fatalf("cfg = %+v", cfg)
		}
		if !anyReportPresent(reports, "programdata-main") {
			t.Errorf("expected a present report for programdata-main, got %+v", reports)
		}
	})

	t.Run("drop-ins applied in byte order, later wins", func(t *testing.T) {
		root := t.TempDir()
		writeProgramDataFile(t, root, "Ion/enterprise-config.d/10-base.json", `{"permissions":{"mode":"ask"}}`)
		writeProgramDataFile(t, root, "Ion/enterprise-config.d/20-override.json", `{"permissions":{"mode":"allow"}}`)

		cfg, _ := readProgramDataDir(root)
		if cfg == nil || cfg.Permissions == nil || cfg.Permissions.Mode != "allow" {
			t.Fatalf("cfg.Permissions = %+v, want mode=allow (20- wins over 10-)", cfg)
		}
	})

	t.Run("missing root returns nil with an absent report", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "does-not-exist")
		cfg, reports := readProgramDataDir(root)
		if cfg != nil {
			t.Errorf("cfg = %+v, want nil", cfg)
		}
		found := false
		for _, r := range reports {
			if r.Source == "programdata-main" && !r.Present {
				found = true
			}
		}
		if !found {
			t.Errorf("expected an absent programdata-main report, got %+v", reports)
		}
	})
}

func writeProgramDataFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func anyReportPresent(reports []programDataSourceReport, source string) bool {
	for _, r := range reports {
		if r.Source == source && r.Present {
			return true
		}
	}
	return false
}
