package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Proves the shipped reference enterprise config actually overrides a
// hand-edited user layer, using the real loader and the real enforcement.
func TestReferenceEnterpriseConfigOverridesUser(t *testing.T) {
	refPath := filepath.Join("..", "..", "..", "docs", "enterprise", "reference", "enterprise-config.json")
	if _, err := os.Stat(refPath); err != nil {
		t.Skipf("reference config not present: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", refPath)

	ent := LoadEnterpriseConfig()
	if ent == nil {
		t.Fatal("LoadEnterpriseConfig returned nil for the reference config")
	}

	// A user who has pointed the gateway at their own host, added a second
	// provider, and turned identity off.
	user := &types.EngineRuntimeConfig{
		DefaultModel: "some-other/model",
		Providers: map[string]types.ProviderConfig{
			"gateway": {BaseURL: "https://evil.example", AuthHeader: "authorization", APIKey: "sk-user-key"},
			"personal-openai": {BaseURL: "https://api.openai.com", APIKey: "sk-personal"},
		},
		Auth: &types.AuthConfig{IdentityProvider: "none", RequireOperatorIdentity: false},
	}

	got := EnforceEnterprise(user, ent)

	if got.Providers["gateway"].BaseURL != "https://ai.example.com" {
		t.Errorf("baseURL = %q, want the enterprise gateway", got.Providers["gateway"].BaseURL)
	}
	if got.Providers["gateway"].APIKey != "sk-user-key" {
		t.Errorf("user apiKey = %q, want it preserved", got.Providers["gateway"].APIKey)
	}
	if _, present := got.Providers["personal-openai"]; present {
		t.Error("a provider outside allowedProviders survived enforcement")
	}

	// The reference config deliberately declares no allowedModels. The gateway
	// returns only the models a given subscription key can reach, so it is
	// already the authority on what a user may select; an allowlist here would
	// be a second copy of that decision that goes stale the moment a
	// subscription changes. Pinning its absence keeps a well-meaning addition
	// from silently hiding models a user is entitled to -- which is exactly
	// what a one-entry list did on a tenant whose gateway offered sixteen.
	if len(ent.AllowedModels) != 0 {
		t.Errorf("AllowedModels = %v, want none; the gateway decides model access", ent.AllowedModels)
	}
	if got.DefaultModel != "some-other/model" {
		t.Errorf("defaultModel = %q, want the user's choice preserved when no allowlist constrains it", got.DefaultModel)
	}
	if got.Auth == nil || got.Auth.IdentityProvider != "entra" {
		t.Errorf("identityProvider = %+v, want entra", got.Auth)
	}
	if !got.Auth.RequireOperatorIdentity {
		t.Error("requireOperatorIdentity was disabled by the user layer")
	}
	if got.Auth.OAuth["entra"].ClientID == "" {
		t.Error("entra oauth client details did not survive")
	}

	// The desktop's own policy rides customFields["ion-desktop"], which the
	// engine carries verbatim without interpreting. disableAutoUpdate is what
	// stops a managed install fighting the version MDM pinned -- an engine
	// that dropped the namespace would leave the desktop updating itself with
	// no error anywhere.
	desktop, ok := ent.CustomFields["ion-desktop"].(map[string]any)
	if !ok {
		t.Fatalf("customFields[\"ion-desktop\"] = %#v, want a map", ent.CustomFields["ion-desktop"])
	}
	if desktop["disableAutoUpdate"] != true {
		t.Errorf("disableAutoUpdate = %v, want true", desktop["disableAutoUpdate"])
	}

	// tabStripPolicy carries no "locked" key on purpose: it is a managed
	// default the user may override, not an enforcement. A locked:true added
	// here would seal a preference the deployment deliberately leaves open.
	strip, ok := desktop["tabStripPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("tabStripPolicy = %#v, want a map", desktop["tabStripPolicy"])
	}
	if strip["visible"] != false {
		t.Errorf("tabStripPolicy.visible = %v, want false", strip["visible"])
	}
	if _, locked := strip["locked"]; locked {
		t.Errorf("tabStripPolicy carries locked=%v; the reference is a managed default, not an enforcement", strip["locked"])
	}
}
