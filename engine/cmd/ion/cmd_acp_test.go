package main

import (
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
