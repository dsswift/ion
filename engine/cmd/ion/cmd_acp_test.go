package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// The acp command's options come from its flags and the settings.json
// profile catalog; each profile's extension paths are resolved the way
// `ion prompt --extension` resolves them.
func TestAcpOptionsBuildTheProfileCatalog(t *testing.T) {
	profiles := []types.EngineProfileConfig{
		{ID: "a1", Name: "cos2", Extensions: []string{"~/.ion/extensions/cos2/main"}},
		{ID: "b2", Name: "legacy", ExtensionDir: "~/.ion/extensions/legacy"},
	}
	opts := acpOptions(map[string]string{"profile": "cos2", "model": "m-1"}, profiles, "default-model")
	if opts.Profile != "cos2" || opts.Model != "m-1" || opts.DefaultModel != "default-model" || opts.Version != version {
		t.Fatalf("opts = %+v", opts)
	}
	if len(opts.Profiles) != 2 {
		t.Fatalf("profiles = %+v", opts.Profiles)
	}
	if p := opts.Profiles[0]; p.ID != "a1" || p.Name != "cos2" || len(p.Extensions) != 1 || p.Extensions[0] == "~/.ion/extensions/cos2/main" {
		t.Fatalf("cos2 profile = %+v (tilde must be expanded)", p)
	}
	if p := opts.Profiles[1]; len(p.Extensions) != 1 || p.Extensions[0] == "" {
		t.Fatalf("legacy extensionDir not resolved: %+v", p)
	}
}

// --harness names the agent after the extension's manifest, else its
// directory, and resolves a file entry point to its directory's manifest.
func TestAcpHarnessResolvesTheExtension(t *testing.T) {
	dir := t.TempDir()
	named := filepath.Join(dir, "cos2")
	plain := filepath.Join(dir, "jarvis")
	for _, d := range []string{named, plain} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(named, "extension.json"), []byte(`{"name":"chief"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plain, "main"), []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}

	h, err := acpHarness(map[string]string{"harness": named, "title": "Chief of Staff"})
	if err != nil || h.Name != "chief" || h.Title != "Chief of Staff" || h.Path != named {
		t.Fatalf("manifest harness = %+v, %v", h, err)
	}
	h, err = acpHarness(map[string]string{"harness": filepath.Join(plain, "main")})
	if err != nil || h.Name != "jarvis" || h.Path != filepath.Join(plain, "main") {
		t.Fatalf("file harness = %+v, %v", h, err)
	}
	if h, err := acpHarness(map[string]string{}); h != nil || err != nil {
		t.Fatalf("no flag = %+v, %v", h, err)
	}
}

func TestAcpHarnessRefusesConflictingFlags(t *testing.T) {
	dir := t.TempDir()
	for name, flags := range map[string]map[string]string{
		"profile":      {"harness": dir, "profile": "cos2"},
		"title alone":  {"title": "Chief of Staff"},
		"missing path": {"harness": filepath.Join(dir, "absent")},
	} {
		if _, err := acpHarness(flags); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
