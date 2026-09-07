package modelconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// isolateHome redirects HOME to a temp dir so every models.json read/write in
// this file is disposable and never touches the operator's real ~/.ion.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".ion"), 0o700); err != nil {
		t.Fatalf("create temp .ion: %v", err)
	}
	return home
}

func TestDefaultProviderID_UnsetAndSet(t *testing.T) {
	isolateHome(t)

	if got := DefaultProviderID(); got != "" {
		t.Fatalf("DefaultProviderID with no config = %q, want empty", got)
	}
	if _, err := SetDefaultProvider("  DCI-Marketing  "); err != nil {
		t.Fatalf("SetDefaultProvider: %v", err)
	}
	if got := DefaultProviderID(); got != "dci-marketing" {
		t.Fatalf("DefaultProviderID = %q, want dci-marketing", got)
	}
}

func TestSetDefaultProvider_EmptyRemovesKey(t *testing.T) {
	home := isolateHome(t)

	if _, err := SetDefaultProvider("dci-marketing"); err != nil {
		t.Fatalf("SetDefaultProvider: %v", err)
	}
	if _, err := SetDefaultProvider(""); err != nil {
		t.Fatalf("SetDefaultProvider clear: %v", err)
	}
	if got := DefaultProviderID(); got != "" {
		t.Fatalf("DefaultProviderID after clear = %q, want empty", got)
	}

	// The key must be absent, not present-but-empty: an empty-string value
	// would still read as a configured preference to any external consumer
	// inspecting models.json directly.
	data, err := os.ReadFile(filepath.Join(home, ".ion", "models.json"))
	if err != nil {
		t.Fatalf("read models.json: %v", err)
	}
	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatalf("parse models.json: %v", err)
	}
	if _, present := config["defaultProvider"]; present {
		t.Fatalf("defaultProvider key still present after clear: %s", data)
	}
}

// registerDefaultProviderModels wires a fake default provider plus a
// competing anthropic-served bare model, and cleans the global registry up.
func registerDefaultProviderModels(t *testing.T) {
	t.Helper()
	providers.RegisterModel("defprov/dp-bare-model", types.ModelInfo{ProviderID: "defprov"})
	providers.RegisterModel("dp-bare-model", types.ModelInfo{ProviderID: "anthropic"})
	providers.RegisterModel("anthropic/dp-bare-model", types.ModelInfo{ProviderID: "anthropic"})
	providers.RegisterModel("dp-native", types.ModelInfo{ProviderID: "defprov"})
	t.Cleanup(func() {
		providers.UnregisterModel("defprov/dp-bare-model")
		providers.UnregisterModel("dp-bare-model")
		providers.UnregisterModel("anthropic/dp-bare-model")
		providers.UnregisterModel("dp-native")
	})
}

func TestApplyDefaultProvider(t *testing.T) {
	isolateHome(t)
	registerDefaultProviderModels(t)
	if _, err := SetDefaultProvider("defprov"); err != nil {
		t.Fatalf("SetDefaultProvider: %v", err)
	}

	cases := []struct {
		name  string
		model string
		want  string
	}{
		{"qualified model untouched", "anthropic/dp-bare-model", "anthropic/dp-bare-model"},
		{"bare model served by default provider", "dp-bare-model", "defprov/dp-bare-model"},
		{"bare model not served by default provider", "dp-unknown-model", "dp-unknown-model"},
		{"bare model already on default provider", "dp-native", "dp-native"},
		{"empty model", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ApplyDefaultProvider(tc.model); got != tc.want {
				t.Fatalf("ApplyDefaultProvider(%q) = %q, want %q", tc.model, got, tc.want)
			}
		})
	}
}

func TestApplyDefaultProvider_NoPreferenceLeavesBareModel(t *testing.T) {
	isolateHome(t)
	registerDefaultProviderModels(t)

	if got := ApplyDefaultProvider("dp-bare-model"); got != "dp-bare-model" {
		t.Fatalf("ApplyDefaultProvider without preference = %q, want dp-bare-model", got)
	}
}
