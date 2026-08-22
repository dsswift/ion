package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestRootAgentSpawner_ProviderLocksAgentModel(t *testing.T) {
	const gateway = "dispatch-origin-gateway"
	const model = "dispatch-origin-model"
	qualified := gateway + "/" + model
	providers.RegisterModel("dispatch-origin-parent", types.ModelInfo{ProviderID: gateway})
	providers.RegisterModel(model, types.ModelInfo{ProviderID: "anthropic"})
	providers.RegisterModel(qualified, types.ModelInfo{ProviderID: gateway})
	t.Cleanup(func() {
		providers.UnregisterModel("dispatch-origin-parent")
		providers.UnregisterModel(model)
		providers.UnregisterModel(qualified)
	})

	mgr := NewManager(newMockBackend())
	_, _ = mgr.StartSession("origin-lock", defaultConfig())
	mgr.childBackendOverride = func() backend.RunBackend { return &childStubBackend{} }
	mgr.mu.Lock()
	s := mgr.sessions["origin-lock"]
	mgr.mu.Unlock()

	spawner := mgr.buildRootAgentSpawner(s, "origin-lock", "dispatch-origin-parent", nil, nil, nil)
	if _, err := spawner(context.Background(), "", "work", "", "", model); err != nil {
		t.Fatalf("same-provider bare request: %v", err)
	}

	_, err := spawner(context.Background(), "", "work", "", "", "anthropic/"+model)
	if err == nil || !strings.Contains(err.Error(), "locked to provider") {
		t.Fatalf("cross-provider error = %v, want provider lock refusal", err)
	}
}
