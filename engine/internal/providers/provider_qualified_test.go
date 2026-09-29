package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A provider-qualified id names the bare entry the registry serves from that
// provider. Before this, only ResolveProvider understood the qualified form:
// GetModelInfo and ProviderNameForModel missed, so backend routing saw an
// unknown provider and sent an explicit "anthropic/<model>" pick down the
// keyed API path with no key, and the context window fell back to a default.
func TestGetModelInfo_ProviderQualifiedID(t *testing.T) {
	RegisterModel("qualified-test-model", types.ModelInfo{ProviderID: "qualified-test-provider", ContextWindow: 123})
	t.Cleanup(func() { UnregisterModel("qualified-test-model") })

	info := GetModelInfo("qualified-test-provider/qualified-test-model")
	if info == nil || info.ProviderID != "qualified-test-provider" || info.ContextWindow != 123 {
		t.Fatalf("qualified id did not resolve to the bare entry: %+v", info)
	}
	if got := ProviderNameForModel("qualified-test-provider/qualified-test-model"); got != "qualified-test-provider" {
		t.Errorf("ProviderNameForModel = %q, want qualified-test-provider", got)
	}
	// Another provider's qualifier on the same bare id must not reroute.
	if info := GetModelInfo("other-provider/qualified-test-model"); info != nil {
		t.Errorf("foreign qualifier resolved: %+v", info)
	}
	if got := ProviderNameForModel("other-provider/qualified-test-model"); got != "" {
		t.Errorf("foreign qualifier named a provider: %q", got)
	}
	// Degenerate shapes stay unresolved.
	for _, id := range []string{"/qualified-test-model", "qualified-test-provider/", "qualified-test-provider/missing"} {
		if info := GetModelInfo(id); info != nil {
			t.Errorf("%q resolved: %+v", id, info)
		}
	}
}

// An id registered with a slash in it (OpenRouter style) takes the exact
// branch and is never split.
func TestGetModelInfo_SlashInRegisteredID(t *testing.T) {
	RegisterModel("slash-vendor/slash-model", types.ModelInfo{ProviderID: "slash-router"})
	t.Cleanup(func() { UnregisterModel("slash-vendor/slash-model") })

	info := GetModelInfo("slash-vendor/slash-model")
	if info == nil || info.ProviderID != "slash-router" {
		t.Fatalf("exact slash id: %+v", info)
	}
}

func TestWireModelID(t *testing.T) {
	RegisterModel("wire-test-model", types.ModelInfo{ProviderID: "wire-test-provider"})
	RegisterModel("wire-vendor/wire-exact", types.ModelInfo{ProviderID: "wire-router"})
	t.Cleanup(func() {
		UnregisterModel("wire-test-model")
		UnregisterModel("wire-vendor/wire-exact")
	})

	cases := map[string]string{
		"wire-test-provider/wire-test-model": "wire-test-model",        // qualified -> bare
		"wire-test-model":                    "wire-test-model",        // bare unchanged
		"wire-vendor/wire-exact":             "wire-vendor/wire-exact", // exact slash id kept
		"other/wire-test-model":              "other/wire-test-model",  // unresolved, untouched
		"never-registered":                   "never-registered",
	}
	for in, want := range cases {
		if got := WireModelID(in); got != want {
			t.Errorf("WireModelID(%q) = %q, want %q", in, got, want)
		}
	}
}
