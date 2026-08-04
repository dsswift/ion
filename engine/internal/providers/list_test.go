package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestListModels(t *testing.T) {
	// ListModels should return all registered models sorted by provider then ID.
	models := ListModels()
	if len(models) == 0 {
		t.Fatal("expected at least one registered model")
	}

	// Should include known models from init()
	found := make(map[string]bool)
	for _, m := range models {
		found[m.ID] = true
	}

	expectedModels := []string{
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"gpt-4.1",
		"o4-mini",
	}
	for _, id := range expectedModels {
		if !found[id] {
			t.Errorf("expected model %q in ListModels output", id)
		}
	}

	// Verify sort order: should be sorted by provider then ID
	for i := 1; i < len(models); i++ {
		if models[i-1].ProviderID > models[i].ProviderID {
			t.Errorf("models not sorted by provider: %s > %s", models[i-1].ProviderID, models[i].ProviderID)
		}
		if models[i-1].ProviderID == models[i].ProviderID && models[i-1].ID > models[i].ID {
			t.Errorf("models not sorted by ID within provider %s: %s > %s", models[i].ProviderID, models[i-1].ID, models[i].ID)
		}
	}

	// Verify fields are populated
	for _, m := range models {
		if m.ProviderID == "" {
			t.Errorf("model %q has empty ProviderID", m.ID)
		}
		// Image-generation models have no concept of a context window (they accept
		// a single prompt string, not a token-counted conversation). Exempt them
		// from the ContextWindow > 0 check.
		if m.ModelKind != "image" && m.ContextWindow <= 0 {
			t.Errorf("model %q has invalid ContextWindow: %d", m.ID, m.ContextWindow)
		}
	}
}

func TestListProviderIDs(t *testing.T) {
	// Ensure required providers exist (earlier tests may have removed init()-registered ones)
	ensureIDs := []string{"anthropic", "openai", "google", "groq", "ollama"}
	for _, id := range ensureIDs {
		if GetProvider(id) == nil {
			RegisterProvider(&mockProvider{id: id})
		}
	}

	ids := ListProviderIDs()
	if len(ids) == 0 {
		t.Fatal("expected at least one registered provider")
	}

	idSet := make(map[string]bool)
	for _, id := range ids {
		idSet[id] = true
	}

	for _, p := range ensureIDs {
		if !idSet[p] {
			t.Errorf("expected provider %q in ListProviderIDs output", p)
		}
	}

	// Verify sort order
	for i := 1; i < len(ids); i++ {
		if ids[i-1] > ids[i] {
			t.Errorf("provider IDs not sorted: %s > %s", ids[i-1], ids[i])
		}
	}
}

// TestListModelsEnrichmentFillIfZero guards the enrichment contract: catalog
// metadata only fills fields the discovered entry left empty. A discovered
// model carrying live metadata (extended /models payload) must never have its
// values clobbered by the embedded catalog.
func TestListModelsEnrichmentFillIfZero(t *testing.T) {
	ResetDiscoveryCache()
	t.Cleanup(ResetDiscoveryCache)

	// claude-opus-4-6 exists in the embedded catalog with its own metadata.
	// Discover it with different live metadata and verify the live values survive.
	live := types.ModelEntry{
		ID:               "claude-opus-4-6",
		ProviderID:       "anthropic",
		ContextWindow:    1000000,
		CostPer1kInput:   0.009,
		CostPer1kOutput:  0.045,
		SupportsCaching:  true,
		SupportsThinking: true,
		SupportsImages:   true,
		ThinkingMode:     "adaptive",
		ThinkingEfforts:  []string{"low", "high"},
	}
	// Sparse sibling: only ID — catalog must fill everything it knows.
	sparse := types.ModelEntry{ID: "claude-sonnet-4-6", ProviderID: "anthropic"}
	SetExternalModels("anthropic", []types.ModelEntry{live, sparse})

	byID := make(map[string]types.ModelEntry)
	for _, m := range ListModels() {
		byID[m.ID] = m
	}

	got, ok := byID["claude-opus-4-6"]
	if !ok {
		t.Fatal("discovered model claude-opus-4-6 missing from ListModels")
	}
	if got.ContextWindow != 1000000 {
		t.Errorf("live ContextWindow clobbered: got %d want 1000000", got.ContextWindow)
	}
	if got.CostPer1kInput != 0.009 || got.CostPer1kOutput != 0.045 {
		t.Errorf("live costs clobbered: got %v/%v want 0.009/0.045", got.CostPer1kInput, got.CostPer1kOutput)
	}
	if got.ThinkingMode != "adaptive" {
		t.Errorf("live ThinkingMode clobbered: got %q want %q", got.ThinkingMode, "adaptive")
	}
	if len(got.ThinkingEfforts) != 2 {
		t.Errorf("live ThinkingEfforts clobbered: got %v", got.ThinkingEfforts)
	}
	if !got.SupportsCaching || !got.SupportsThinking || !got.SupportsImages {
		t.Errorf("live capability flags lost: caching=%v thinking=%v images=%v", got.SupportsCaching, got.SupportsThinking, got.SupportsImages)
	}

	gotSparse, ok := byID["claude-sonnet-4-6"]
	if !ok {
		t.Fatal("discovered model claude-sonnet-4-6 missing from ListModels")
	}
	if gotSparse.ContextWindow == 0 {
		t.Error("catalog enrichment did not fill ContextWindow for sparse discovered entry")
	}
	if gotSparse.CostPer1kInput == 0 {
		t.Error("catalog enrichment did not fill CostPer1kInput for sparse discovered entry")
	}
}

// TestListModels_CollidedGatewayModelEmitsQualifiedID is the regression test
// for the model-identity collision that misrouted a gateway pick to the wrong
// provider: a dci-marketing "claude-sonnet-4-6" selection dispatched as the
// bare id, which the routing registry resolves to anthropic, which hybrid
// routing sent to the delegated Claude CLI.
//
// storeResult registers gateway copies of collided models under the qualified
// "<provider>/<model>" id only (dual-provider coexistence). ListModels must
// advertise that same qualified id for the gateway's entry — never the bare id
// the gateway's /models payload used, because that id does not route to the
// gateway. Reverting the qualification branch in ListModels turns this red.
func TestListModels_CollidedGatewayModelEmitsQualifiedID(t *testing.T) {
	ResetDiscoveryCache()
	t.Cleanup(ResetDiscoveryCache)

	const gateway = "collide-gw"
	// The bare id is owned by anthropic (embedded catalog). Simulate what
	// storeResult does for a dialect-carrying gateway copy: the discovery
	// cache holds the bare id under the gateway, and the registry holds the
	// qualified alias routing to the gateway.
	RegisterModel(gateway+"/claude-sonnet-4-6", types.ModelInfo{
		ProviderID:    gateway,
		ContextWindow: 1_000_000,
		Dialect:       "anthropic",
	})
	t.Cleanup(func() { UnregisterModel(gateway + "/claude-sonnet-4-6") })
	setDiscoveredOnly(gateway, []types.ModelEntry{{
		ID: "claude-sonnet-4-6", ProviderID: gateway, ContextWindow: 1_000_000, Dialect: "anthropic",
	}})

	var gatewayIDs []string
	bareStillAnthropicListed := false
	for _, m := range ListModels() {
		if m.ProviderID == gateway {
			gatewayIDs = append(gatewayIDs, m.ID)
		}
		if m.ID == "claude-sonnet-4-6" && m.ProviderID == "anthropic" {
			bareStillAnthropicListed = true
		}
	}
	if len(gatewayIDs) != 1 || gatewayIDs[0] != gateway+"/claude-sonnet-4-6" {
		t.Fatalf("gateway entry ids = %v, want exactly [%s/claude-sonnet-4-6] — a bare collided id advertises an identity that routes to anthropic", gatewayIDs, gateway)
	}
	if !bareStillAnthropicListed {
		t.Error("anthropic's own bare claude-sonnet-4-6 disappeared from ListModels")
	}
}

// TestListModels_NonCollidedDiscoveredIDStaysBare pins the inverse: a
// discovered model whose bare id belongs to the same provider is emitted
// unqualified, so ordinary providers see zero change from the collision fix.
func TestListModels_NonCollidedDiscoveredIDStaysBare(t *testing.T) {
	ResetDiscoveryCache()
	t.Cleanup(ResetDiscoveryCache)

	SetExternalModels("anthropic", []types.ModelEntry{{ID: "claude-sonnet-4-6", ProviderID: "anthropic"}})
	for _, m := range ListModels() {
		if m.ProviderID == "anthropic" && m.ID == "anthropic/claude-sonnet-4-6" {
			t.Fatal("non-collided discovered id was qualified; same-provider ids must stay bare")
		}
	}
}

// TestListModels_CollidedWithoutQualifiedRegistrationEmitsBare covers the
// config-gap arm: the bare id collides but no qualified alias exists in the
// registry (a non-dialect payload storeResult does not qualify). There is no
// id that routes to this provider, so ListModels emits the bare id (with a
// WARN in the log) rather than inventing an id routing cannot resolve.
func TestListModels_CollidedWithoutQualifiedRegistrationEmitsBare(t *testing.T) {
	ResetDiscoveryCache()
	t.Cleanup(ResetDiscoveryCache)

	const gateway = "collide-noq"
	setDiscoveredOnly(gateway, []types.ModelEntry{{ID: "claude-sonnet-4-6", ProviderID: gateway}})

	sawBare := false
	for _, m := range ListModels() {
		if m.ProviderID == gateway {
			if m.ID != "claude-sonnet-4-6" {
				t.Fatalf("unexpected gateway id %q; without a qualified registration the bare id must pass through", m.ID)
			}
			sawBare = true
		}
	}
	if !sawBare {
		t.Fatal("gateway entry missing from ListModels")
	}
}

// setDiscoveredOnly seeds the discovery cache without touching the model
// registry — unlike SetExternalModels, which also registers bare ids. This is
// the shape runDiscoveryAll/storeResult leaves for a COLLIDED model: cache
// entry under the gateway, registry bare id still owned by the original
// provider.
func setDiscoveredOnly(providerID string, models []types.ModelEntry) {
	discoveryMu.Lock()
	discoveryCache[providerID] = &providerDiscovery{models: models}
	discoveryMu.Unlock()
}
