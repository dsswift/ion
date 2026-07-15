package plugins

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadManifest_Present(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, ".claude-plugin")
	os.MkdirAll(pluginDir, 0o755)
	content := `{
		"name": "caveman",
		"description": "Talk like caveman",
		"hooks": {
			"SessionStart": [{"hooks": [{"type": "command","command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/activate.js","timeout": 5}]}],
			"UserPromptSubmit": [{"hooks": [{"type": "command","command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/track.js","timeout": 3}]}]
		}
	}`
	os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte(content), 0o644)

	m, err := LoadManifest(dir)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	if m == nil {
		t.Fatal("expected non-nil manifest")
	}
	if m.Name != "caveman" {
		t.Errorf("Name = %q, want %q", m.Name, "caveman")
	}

	ssHooks := m.SessionStartCommands()
	if len(ssHooks) != 1 {
		t.Fatalf("SessionStart hooks = %d, want 1", len(ssHooks))
	}
	if ssHooks[0].Timeout != 5 {
		t.Errorf("Timeout = %d, want 5", ssHooks[0].Timeout)
	}
	if ssHooks[0].EffectiveTimeout().Seconds() != 5 {
		t.Errorf("EffectiveTimeout = %v, want 5s", ssHooks[0].EffectiveTimeout())
	}

	upHooks := m.UserPromptSubmitCommands()
	if len(upHooks) != 1 {
		t.Fatalf("UserPromptSubmit hooks = %d, want 1", len(upHooks))
	}
}

func TestLoadManifest_Missing(t *testing.T) {
	m, err := LoadManifest(t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m != nil {
		t.Error("expected nil manifest for missing file")
	}
}

func TestLoadManifest_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, ".claude-plugin")
	os.MkdirAll(pluginDir, 0o755)
	os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte("{bad json"), 0o644)
	_, err := LoadManifest(dir)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestEffectiveTimeout_Default(t *testing.T) {
	e := PluginHookEntry{Timeout: 0}
	if e.EffectiveTimeout().Seconds() != 30 {
		t.Errorf("want 30s default, got %v", e.EffectiveTimeout())
	}
}

func TestPluginRootExpansion(t *testing.T) {
	cmd := expandPluginRoot("node ${CLAUDE_PLUGIN_ROOT}/hooks/foo.js", "/home/user/.ion/plugins/cache/foo/bar/abc123")
	want := "node /home/user/.ion/plugins/cache/foo/bar/abc123/hooks/foo.js"
	if cmd != want {
		t.Errorf("got %q, want %q", cmd, want)
	}
}
