package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestForgetProvider_RemovesAConfiguredProvider(t *testing.T) {
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries(); ResetDiscoveryCache() })
	ApplyConfig(map[string]types.ProviderConfig{"corp-gateway": {BaseURL: "https://gw.example.org/v1", AuthHeader: "x-api-key"}})
	storeResult("corp-gateway", []types.ModelEntry{{ID: "corp-model", ProviderID: "corp-gateway"}}, nil)
	if GetProvider("corp-gateway") == nil || GetModelInfo("corp-model") == nil {
		t.Fatal("setup: the configured provider and its discovered model should be registered")
	}

	ForgetProvider("corp-gateway")

	if GetProvider("corp-gateway") != nil {
		t.Error("chat provider still registered")
	}
	if GetImageProvider("corp-gateway") != nil {
		t.Error("image provider still registered")
	}
	if GetModelInfo("corp-model") != nil {
		t.Error("model still registered under the forgotten provider")
	}
	if GetDiscoveredModels("corp-gateway") != nil {
		t.Error("discovered models still cached")
	}
	for _, m := range ListModels() {
		if m.ProviderID == "corp-gateway" {
			t.Fatalf("ListModels still lists %s", m.ID)
		}
	}
}

func TestForgetProvider_LeavesABuiltinProvider(t *testing.T) {
	t.Cleanup(func() { ResetRegistries(); restoreInitRegistries() })
	if !IsBuiltinProvider("anthropic") {
		t.Fatal("anthropic should be built in")
	}
	ApplyConfig(map[string]types.ProviderConfig{"corp-gateway": {BaseURL: "https://gw.example.org/v1"}})
	if IsBuiltinProvider("corp-gateway") {
		t.Fatal("a configured provider must not count as built in")
	}

	ForgetProvider("anthropic")

	if GetProvider("anthropic") == nil {
		t.Error("a built-in provider was unregistered")
	}
}
