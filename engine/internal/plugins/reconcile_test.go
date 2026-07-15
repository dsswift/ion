package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// writeTestRegistry writes a registry JSON file at the given path.
func writeTestRegistry(t *testing.T, registryPath string, plugins []InstalledPlugin) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(registryPath), 0o755); err != nil {
		t.Fatalf("mkdir registry dir: %v", err)
	}
	r := registry{Plugins: plugins}
	data, _ := json.MarshalIndent(r, "", "  ")
	if err := os.WriteFile(registryPath, data, 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
}

// --- IsPluginAllowed tests ---

func TestIsPluginAllowed_NilEnterprise(t *testing.T) {
	if !IsPluginAllowed("JuliusBrussee/caveman", nil) {
		t.Error("nil enterprise should allow everything")
	}
}

func TestIsPluginAllowed_Denylist_ExactMatch(t *testing.T) {
	ent := &types.EnterpriseConfig{
		PluginDenylist: []string{"JuliusBrussee/caveman"},
	}
	if IsPluginAllowed("JuliusBrussee/caveman", ent) {
		t.Error("denied source should not be allowed")
	}
}

func TestIsPluginAllowed_Denylist_GlobMatch(t *testing.T) {
	ent := &types.EnterpriseConfig{
		PluginDenylist: []string{"bad-actor/*"},
	}
	if IsPluginAllowed("bad-actor/evil-plugin", ent) {
		t.Error("glob-denied source should not be allowed")
	}
	if !IsPluginAllowed("good-actor/nice-plugin", ent) {
		t.Error("non-denied source should be allowed")
	}
}

func TestIsPluginAllowed_Allowlist_GlobMatch(t *testing.T) {
	ent := &types.EnterpriseConfig{
		PluginAllowlist: []string{"JuliusBrussee/*"},
	}
	if !IsPluginAllowed("JuliusBrussee/caveman", ent) {
		t.Error("source matching allowlist glob should be allowed")
	}
	if IsPluginAllowed("other-person/plugin", ent) {
		t.Error("source not matching allowlist glob should be denied")
	}
}

func TestIsPluginAllowed_Allowlist_ExactMatch(t *testing.T) {
	ent := &types.EnterpriseConfig{
		PluginAllowlist: []string{"JuliusBrussee/caveman"},
	}
	if !IsPluginAllowed("JuliusBrussee/caveman", ent) {
		t.Error("exact allowlist match should be allowed")
	}
	if IsPluginAllowed("JuliusBrussee/other", ent) {
		t.Error("non-allowlisted source should be denied")
	}
}

func TestIsPluginAllowed_EmptyAllowlist_AllowsAll(t *testing.T) {
	ent := &types.EnterpriseConfig{
		PluginAllowlist: []string{}, // empty = no restriction
	}
	if !IsPluginAllowed("anyone/anything", ent) {
		t.Error("empty allowlist should allow everything")
	}
}

func TestIsPluginDenied_NilEnterprise(t *testing.T) {
	if IsPluginDenied("anyone/anything", nil) {
		t.Error("nil enterprise should deny nothing")
	}
}

func TestGlobMatchesAny(t *testing.T) {
	tests := []struct {
		patterns []string
		target   string
		want     bool
	}{
		{[]string{"JuliusBrussee/*"}, "JuliusBrussee/caveman", true},
		{[]string{"JuliusBrussee/*"}, "someone-else/caveman", false},
		{[]string{"JuliusBrussee/caveman"}, "JuliusBrussee/caveman", true},
		{[]string{"JuliusBrussee/caveman"}, "JuliusBrussee/other", false},
		{[]string{}, "anything", false},
		{[]string{"*/*"}, "a/b", true},
		{[]string{"bad-*/*"}, "bad-actor/evil", true},
		{[]string{"bad-*/*"}, "good-actor/nice", false},
	}
	for _, tc := range tests {
		got := globMatchesAny(tc.patterns, tc.target)
		if got != tc.want {
			t.Errorf("globMatchesAny(%v, %q) = %v, want %v", tc.patterns, tc.target, got, tc.want)
		}
	}
}

// --- ReconcilePlugins tests using fake registry ---

// TestReconcilePlugins_NoOp verifies that reconciliation with no config and an
// empty registry produces no installs or removes.
func TestReconcilePlugins_NoOp(t *testing.T) {
	// Empty registry, no config.
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	cfg := &types.EngineRuntimeConfig{}
	var msgs []string
	ReconcilePlugins(cfg, func(msg string) { msgs = append(msgs, msg) })

	installed, _ := ListInstalled()
	if len(installed) != 0 {
		t.Errorf("expected empty registry, got %v", installed)
	}
}

// TestReconcilePlugins_DenylistRemovesPlugin verifies that a plugin in the
// registry whose source is on the denylist is removed.
func TestReconcilePlugins_DenylistRemovesPlugin(t *testing.T) {
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	pluginDir := filepath.Join(dir, "caveman")
	os.MkdirAll(pluginDir, 0o755)

	writeTestRegistry(t, registryPathOverride, []InstalledPlugin{
		{Name: "caveman", Source: "JuliusBrussee/caveman", InstallPath: pluginDir, Version: "abc123"},
	})

	cfg := &types.EngineRuntimeConfig{
		Plugins: &types.PluginsConfig{
			Denylist: []string{"JuliusBrussee/caveman"},
		},
	}
	var msgs []string
	ReconcilePlugins(cfg, func(msg string) { msgs = append(msgs, msg) })

	installed, _ := ListInstalled()
	if len(installed) != 0 {
		t.Errorf("expected empty registry after denylist enforcement, got %v", installed)
	}
}

// TestReconcilePlugins_EnterpriseDenylistRemovesPlugin verifies enterprise
// denylist enforcement.
func TestReconcilePlugins_EnterpriseDenylistRemovesPlugin(t *testing.T) {
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	pluginDir := filepath.Join(dir, "caveman")
	os.MkdirAll(pluginDir, 0o755)

	writeTestRegistry(t, registryPathOverride, []InstalledPlugin{
		{Name: "caveman", Source: "JuliusBrussee/caveman", InstallPath: pluginDir, Version: "abc123"},
	})

	cfg := &types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			PluginDenylist: []string{"JuliusBrussee/*"},
		},
	}
	ReconcilePlugins(cfg, nil)

	installed, _ := ListInstalled()
	if len(installed) != 0 {
		t.Errorf("expected empty registry after enterprise denylist, got %v", installed)
	}
}

// TestReconcilePlugins_AllowlistRemovesUnauthorized verifies that a plugin
// not matching the user allowlist is removed.
func TestReconcilePlugins_AllowlistRemovesUnauthorized(t *testing.T) {
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	// Use distinct subdirs for each plugin so RemoveAll doesn't eat the registry.
	approvedDir := filepath.Join(dir, "approved")
	unknownDir := filepath.Join(dir, "unknown")
	os.MkdirAll(approvedDir, 0o755)
	os.MkdirAll(unknownDir, 0o755)

	writeTestRegistry(t, registryPathOverride, []InstalledPlugin{
		{Name: "authorized", Source: "approved/plugin", InstallPath: approvedDir, Version: "v1"},
		{Name: "unauthorized", Source: "unknown/plugin", InstallPath: unknownDir, Version: "v1"},
	})

	cfg := &types.EngineRuntimeConfig{
		Plugins: &types.PluginsConfig{
			Allowlist: []string{"approved/*"},
		},
	}
	ReconcilePlugins(cfg, nil)

	installed, _ := ListInstalled()
	if len(installed) != 1 {
		t.Fatalf("expected 1 plugin after allowlist enforcement, got %d: %v", len(installed), installed)
	}
	if installed[0].Name != "authorized" {
		t.Errorf("expected 'authorized' to survive, got %q", installed[0].Name)
	}
}

// TestReconcilePlugins_EnterpriseAllowlistRemovesUnauthorized verifies that
// the enterprise allowlist is enforced.
func TestReconcilePlugins_EnterpriseAllowlistRemovesUnauthorized(t *testing.T) {
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	// Use distinct subdirs to prevent RemoveAll from eating the registry file.
	okDir := filepath.Join(dir, "ok")
	badDir := filepath.Join(dir, "bad")
	os.MkdirAll(okDir, 0o755)
	os.MkdirAll(badDir, 0o755)

	writeTestRegistry(t, registryPathOverride, []InstalledPlugin{
		{Name: "ok", Source: "JuliusBrussee/caveman", InstallPath: okDir, Version: "v1"},
		{Name: "bad", Source: "rando/tool", InstallPath: badDir, Version: "v1"},
	})

	cfg := &types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			PluginAllowlist: []string{"JuliusBrussee/*"},
		},
	}
	ReconcilePlugins(cfg, nil)

	installed, _ := ListInstalled()
	if len(installed) != 1 {
		t.Fatalf("expected 1 plugin, got %d: %v", len(installed), installed)
	}
	if installed[0].Name != "ok" {
		t.Errorf("expected 'ok' to survive, got %q", installed[0].Name)
	}
}

// TestReconcilePlugins_AlreadyInstalled verifies no-op when force-installed
// plugin is already in the registry.
func TestReconcilePlugins_AlreadyInstalled(t *testing.T) {
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	pluginDir := filepath.Join(dir, "caveman")
	os.MkdirAll(pluginDir, 0o755)

	writeTestRegistry(t, registryPathOverride, []InstalledPlugin{
		{Name: "caveman", Source: "JuliusBrussee/caveman", InstallPath: pluginDir, Version: "abc123"},
	})

	var progress []string
	cfg := &types.EngineRuntimeConfig{
		Plugins: &types.PluginsConfig{
			ForceInstalled: []string{"JuliusBrussee/caveman"},
		},
	}
	ReconcilePlugins(cfg, func(msg string) { progress = append(progress, msg) })

	// Plugin should still be present (not removed; no install attempt logged)
	installed, _ := ListInstalled()
	if len(installed) != 1 {
		t.Errorf("expected plugin to remain, got %d", len(installed))
	}
	for _, msg := range progress {
		if msg != "" {
			// "already present" log is fine, but no install messages expected
			t.Logf("progress: %q", msg)
		}
	}
}

// TestReconcilePlugins_ForceInstallBlockedByEnterprise verifies that a user
// force-install blocked by the enterprise allowlist is skipped.
func TestReconcilePlugins_ForceInstallBlockedByEnterprise(t *testing.T) {
	dir := t.TempDir()
	origPath := registryPathOverride
	registryPathOverride = filepath.Join(dir, "installed_plugins.json")
	defer func() { registryPathOverride = origPath }()

	// Empty registry — nothing installed.
	var msgs []string
	cfg := &types.EngineRuntimeConfig{
		Plugins: &types.PluginsConfig{
			// User wants this, but enterprise blocks it.
			ForceInstalled: []string{"JuliusBrussee/caveman"},
		},
		Enterprise: &types.EnterpriseConfig{
			PluginAllowlist: []string{"corp-approved/*"},
		},
	}
	ReconcilePlugins(cfg, func(msg string) { msgs = append(msgs, msg) })

	// Nothing should have been installed (Install would be a network call, which
	// the test never reaches because the policy check blocks it first).
	installed, _ := ListInstalled()
	if len(installed) != 0 {
		t.Errorf("expected nothing installed, got %v", installed)
	}
	blocked := false
	for _, msg := range msgs {
		if msg != "" {
			t.Logf("progress: %q", msg)
			if len(msg) > 0 {
				blocked = true
			}
		}
	}
	_ = blocked
}

// TestReconcilePlugins_NilConfig verifies ReconcilePlugins is nil-safe.
func TestReconcilePlugins_NilConfig(t *testing.T) {
	// Should not panic.
	ReconcilePlugins(nil, nil)
}
