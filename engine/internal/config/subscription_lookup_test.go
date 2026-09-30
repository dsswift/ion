package config

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestSubscriptionLookupDecodesAndMergesAsOneBlock(t *testing.T) {
	var user types.EngineRuntimeConfig
	if err := json.Unmarshal([]byte(`{"subscriptionLookup":{"endpoint":"https://user.example.invalid/s","provider":"gateway","cacheMaxAgeSeconds":60}}`), &user); err != nil {
		t.Fatal(err)
	}
	var project types.EngineRuntimeConfig
	if err := json.Unmarshal([]byte(`{"subscriptionLookup":{"endpoint":"https://project.example.invalid/s","provider":"other"}}`), &project); err != nil {
		t.Fatal(err)
	}
	var merged types.EngineRuntimeConfig
	mergeInto(&merged, &user)
	if merged.SubscriptionLookup == nil || merged.SubscriptionLookup.CacheMaxAgeSeconds != 60 {
		t.Fatalf("user layer not carried: %+v", merged.SubscriptionLookup)
	}
	mergeInto(&merged, &project)
	if got := merged.SubscriptionLookup; got.Endpoint != "https://project.example.invalid/s" || got.Provider != "other" || got.CacheMaxAgeSeconds != 0 {
		t.Fatalf("project layer did not replace the block: %+v", got)
	}
}

func TestEnterpriseSealsSubscriptionLookup(t *testing.T) {
	base := &types.EngineRuntimeConfig{SubscriptionLookup: &types.SubscriptionLookupConfig{Endpoint: "https://user.example.invalid/s", Provider: "gateway"}}
	enterprise := mergeEnterprisePartial(&types.EnterpriseConfig{},
		&types.EnterpriseConfig{SubscriptionLookup: &types.SubscriptionLookupConfig{Endpoint: "https://keys.example.invalid/s", Provider: "gateway", Scope: "api://keys/.default"}})
	result := EnforceEnterprise(base, enterprise)
	if got := result.SubscriptionLookup; got == nil || got.Endpoint != "https://keys.example.invalid/s" || got.Scope != "api://keys/.default" {
		t.Fatalf("enterprise block not sealed: %+v", got)
	}
	if base.SubscriptionLookup.Endpoint != "https://user.example.invalid/s" {
		t.Fatal("enforcement mutated the input config")
	}

	unmanaged := EnforceEnterprise(base, &types.EnterpriseConfig{})
	if unmanaged.SubscriptionLookup == nil || unmanaged.SubscriptionLookup.Endpoint != "https://user.example.invalid/s" {
		t.Fatalf("user block dropped without enterprise policy: %+v", unmanaged.SubscriptionLookup)
	}
}
