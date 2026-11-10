package config

import (
	"sort"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestPermittedProviders(t *testing.T) {
	if got := PermittedProviders(nil); got != nil {
		t.Fatalf("nil policy = %v, want nil", got)
	}
	if got := PermittedProviders(&types.EnterpriseConfig{}); got != nil {
		t.Fatalf("no allow-list = %v, want nil", got)
	}
	got := PermittedProviders(&types.EnterpriseConfig{
		AllowedProviders: []string{"corp"},
		Providers:        map[string]types.ProviderConfig{"corp": {}, "corp-eu": {}},
	})
	sort.Strings(got)
	if len(got) != 2 || got[0] != "corp" || got[1] != "corp-eu" {
		t.Fatalf("permitted = %v, want [corp corp-eu]", got)
	}
}
