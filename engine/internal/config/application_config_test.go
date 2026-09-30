package config

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestApplicationConfigDecodesAndMerges(t *testing.T) {
	var layer types.EngineRuntimeConfig
	raw := `{"applicationConfig":{"endpoint":"https://config.example.invalid","refreshSeconds":900,"scope":"api://config/.default"}}`
	if err := json.Unmarshal([]byte(raw), &layer); err != nil {
		t.Fatalf("decode: %v", err)
	}
	merged := MergeConfigs(nil, DefaultConfig(), &layer)
	got := merged.ApplicationConfig
	if got == nil || got.Endpoint != "https://config.example.invalid" || got.RefreshSeconds != 900 || got.Scope != "api://config/.default" {
		t.Fatalf("applicationConfig dropped or altered by merge: %+v", got)
	}
	if DefaultConfig().ApplicationConfig != nil {
		t.Fatal("the default config must leave application config unconfigured")
	}
}

func TestEnterpriseApplicationConfigReplacesUserBlock(t *testing.T) {
	user := &types.EngineRuntimeConfig{ApplicationConfig: &types.ApplicationConfigSource{Endpoint: "https://user.example.invalid", Scope: "user"}}
	enterprise := &types.EnterpriseConfig{ApplicationConfig: &types.ApplicationConfigSource{Endpoint: "https://org.example.invalid"}}
	sealed := EnforceEnterprise(user, enterprise)
	if sealed.ApplicationConfig.Endpoint != "https://org.example.invalid" || sealed.ApplicationConfig.Scope != "" {
		t.Fatalf("an enterprise block must replace the user's whole: %+v", sealed.ApplicationConfig)
	}
	untouched := EnforceEnterprise(&types.EngineRuntimeConfig{ApplicationConfig: user.ApplicationConfig}, &types.EnterpriseConfig{})
	if untouched.ApplicationConfig.Endpoint != "https://user.example.invalid" {
		t.Fatalf("no enterprise block must leave the user's alone: %+v", untouched.ApplicationConfig)
	}
	overlaid := mergeEnterprisePartial(&types.EnterpriseConfig{}, enterprise)
	if overlaid.ApplicationConfig == nil || overlaid.ApplicationConfig.Endpoint != "https://org.example.invalid" {
		t.Fatalf("an enterprise drop-in must carry applicationConfig: %+v", overlaid.ApplicationConfig)
	}
}

func TestApplicationConfigIntervals(t *testing.T) {
	for _, tc := range []struct{ in, want int }{{0, 900}, {-5, 900}, {5, 30}, {120, 120}} {
		if got := (&types.ApplicationConfigSource{RefreshSeconds: tc.in}).RefreshInterval(); got != tc.want {
			t.Fatalf("RefreshInterval(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
	if got := (&types.ApplicationConfigSource{}).FetchTimeoutMs(); got != types.DefaultApplicationConfigTimeoutMs {
		t.Fatalf("FetchTimeoutMs default = %d", got)
	}
}
