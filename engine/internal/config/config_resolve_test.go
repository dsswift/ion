package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeEngineJSON writes an engine.json into dir/.ion/engine.json.
func writeEngineJSON(t *testing.T, dir string, cfg map[string]any) {
	t.Helper()
	ionDir := filepath.Join(dir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeGlobalEngineJSON writes an engine.json into $HOME/.ion/engine.json.
func writeGlobalEngineJSON(t *testing.T, home string, cfg map[string]any) {
	t.Helper()
	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolvePlanModeBashAllowlist_GlobalLayer(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeGlobalEngineJSON(t, home, map[string]any{
		"limits": map[string]any{
			"planModeAllowedBashCommands": []string{"gh", "git log", "git diff"},
		},
	})

	cmds, found := ResolvePlanModeBashAllowlist("")
	if !found {
		t.Fatal("expected found=true when global config sets the field")
	}
	if len(cmds) != 3 || cmds[0] != "gh" || cmds[1] != "git log" || cmds[2] != "git diff" {
		t.Fatalf("expected [gh, git log, git diff], got %v", cmds)
	}
}

func TestResolvePlanModeBashAllowlist_ProjectOverridesGlobal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeGlobalEngineJSON(t, home, map[string]any{
		"limits": map[string]any{"planModeAllowedBashCommands": []string{"gh"}},
	})
	projectDir := t.TempDir()
	writeEngineJSON(t, projectDir, map[string]any{
		"limits": map[string]any{"planModeAllowedBashCommands": []string{"git status", "git diff"}},
	})

	cmds, found := ResolvePlanModeBashAllowlist(projectDir)
	if !found {
		t.Fatal("expected found=true")
	}
	if len(cmds) != 2 || cmds[0] != "git status" || cmds[1] != "git diff" {
		t.Fatalf("expected project override [git status, git diff], got %v", cmds)
	}
}

func TestResolvePlanModeBashAllowlist_AbsentIsNotFound(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// No engine.json at all.
	cmds, found := ResolvePlanModeBashAllowlist("")
	if found {
		t.Fatalf("expected found=false when no layer sets the field, got cmds=%v", cmds)
	}
	if cmds != nil {
		t.Fatalf("expected nil cmds when not found, got %v", cmds)
	}
}

func TestResolvePlanModeBashAllowlist_ExplicitEmptyIsFound(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Explicit empty array = "block Bash entirely in plan mode". This must be
	// found=true with an empty (non-nil) slice, distinct from the absent case.
	writeGlobalEngineJSON(t, home, map[string]any{
		"limits": map[string]any{"planModeAllowedBashCommands": []string{}},
	})

	cmds, found := ResolvePlanModeBashAllowlist("")
	if !found {
		t.Fatal("expected found=true for explicit empty array (block-Bash signal)")
	}
	if len(cmds) != 0 {
		t.Fatalf("expected empty allowlist, got %v", cmds)
	}
}

func TestResolvePlanModeBashAllowlist_NoLoggingSideEffects(t *testing.T) {
	// The resolver must be safe to call on every dispatch. It shares
	// mergeConfigLayers with LoadConfig but omits SetLevelFromString /
	// ConfigureLogging. We assert the resolver does not panic and returns a
	// sane result even when logLevel is set in config (which, if the resolver
	// wrongly applied it, would mutate the process-global log level). We only
	// pin the no-panic + correct-value contract here; the absence of the
	// global mutation is guaranteed structurally by mergeConfigLayers not
	// calling SetLevelFromString.
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeGlobalEngineJSON(t, home, map[string]any{
		"logLevel": "debug",
		"limits":   map[string]any{"planModeAllowedBashCommands": []string{"gh"}},
	})
	cmds, found := ResolvePlanModeBashAllowlist("")
	if !found || len(cmds) != 1 || cmds[0] != "gh" {
		t.Fatalf("expected [gh] found=true, got %v found=%v", cmds, found)
	}
}
