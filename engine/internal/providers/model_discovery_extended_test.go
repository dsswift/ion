package providers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// extendedModelsPayload is a gateway-style /v1/models response with extended
// per-entry metadata (dialect, pricing, capabilities).
const extendedModelsPayload = `{
  "object": "list",
  "data": [
    {
      "id": "claude-opus-5",
      "object": "model",
      "owned_by": "dcim-ai-gateway",
      "displayName": "Claude Opus 5",
      "dialect": "anthropic",
      "contextWindow": 1000000,
      "costPer1kInput": 0.005,
      "costPer1kOutput": 0.025,
      "supportsCaching": true,
      "supportsThinking": true,
      "supportsImages": true,
      "thinkingMode": "adaptive",
      "thinkingEfforts": ["low", "medium", "high"]
    },
    {
      "id": "gpt-5.2-codex",
      "object": "model",
      "owned_by": "dcim-ai-gateway",
      "dialect": "openai-responses",
      "contextWindow": 400000,
      "maxOutputTokens": 128000,
      "costPer1kInput": 0.00175,
      "costPer1kOutput": 0.014,
      "supportsThinking": true,
      "thinkingMode": "reasoning_effort",
      "thinkingEfforts": ["low", "medium", "high", "xhigh"]
    },
    {
      "id": "FLUX.2-pro",
      "object": "model",
      "owned_by": "dcim-ai-gateway",
      "dialect": "image",
      "modelKind": "image",
      "costPerImage": 0.03
    }
  ]
}`

// TestDiscoveryExtendedPayload verifies the extended /models decode: dialect,
// pricing, capabilities, and the auth header style used on the request.
func TestDiscoveryExtendedPayload(t *testing.T) {
	var gotPath, gotAPIKeyHeader, gotBearer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAPIKeyHeader = r.Header.Get("x-api-key")
		gotBearer = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, extendedModelsPayload)
	}))
	defer srv.Close()

	models, err := fetchModelsForProvider("dci-marketing", srv.URL, "sub-key", "x-api-key")
	if err != nil {
		t.Fatalf("fetch error: %v", err)
	}

	// Custom provider base URLs get /v1 normalization (APIM path shape).
	if gotPath != "/v1/models" {
		t.Errorf("path = %q, want /v1/models", gotPath)
	}
	// Configured auth header style must be honored (not hardcoded Bearer).
	if gotAPIKeyHeader != "sub-key" {
		t.Errorf("x-api-key = %q, want sub-key", gotAPIKeyHeader)
	}
	if gotBearer != "" {
		t.Errorf("Authorization = %q, want empty (x-api-key style)", gotBearer)
	}

	if len(models) != 3 {
		t.Fatalf("models = %d, want 3", len(models))
	}
	byID := make(map[string]types.ModelEntry)
	for _, m := range models {
		byID[m.ID] = m
	}

	opus := byID["claude-opus-5"]
	if opus.Dialect != "anthropic" {
		t.Errorf("opus dialect = %q, want anthropic", opus.Dialect)
	}
	if opus.DisplayName != "Claude Opus 5" {
		t.Errorf("opus displayName = %q, want Claude Opus 5", opus.DisplayName)
	}
	if opus.ContextWindow != 1000000 || opus.CostPer1kInput != 0.005 || opus.CostPer1kOutput != 0.025 {
		t.Errorf("opus metadata = ctx %d in %v out %v", opus.ContextWindow, opus.CostPer1kInput, opus.CostPer1kOutput)
	}
	if !opus.SupportsCaching || !opus.SupportsThinking || !opus.SupportsImages {
		t.Errorf("opus capabilities lost: %+v", opus)
	}
	if opus.ThinkingMode != "adaptive" || len(opus.ThinkingEfforts) != 3 {
		t.Errorf("opus thinking = %q %v", opus.ThinkingMode, opus.ThinkingEfforts)
	}

	codex := byID["gpt-5.2-codex"]
	if codex.Dialect != "openai-responses" {
		t.Errorf("codex dialect = %q, want openai-responses", codex.Dialect)
	}
	if codex.MaxOutputTokens != 128000 {
		t.Errorf("codex maxOutputTokens = %d, want 128000", codex.MaxOutputTokens)
	}
	if len(codex.ThinkingEfforts) != 4 {
		t.Errorf("codex thinkingEfforts = %v, want 4 levels", codex.ThinkingEfforts)
	}

	flux := byID["FLUX.2-pro"]
	if flux.Dialect != "image" || flux.ModelKind != "image" {
		t.Errorf("flux dialect/kind = %q/%q, want image/image", flux.Dialect, flux.ModelKind)
	}
	if flux.CostPerImage != 0.03 {
		t.Errorf("flux costPerImage = %v, want 0.03", flux.CostPerImage)
	}
}

// TestFetchAnthropicModelsDisplayName verifies the dedicated Anthropic decode:
// its native /v1/models payload is snake_case (`display_name`), which the
// generic camelCase decoder does not read, so fetchAnthropicModels decodes it
// directly and carries the friendly name onto the entry. This is the API-key
// path's parity with the catalog's DisplayName.
func TestFetchAnthropicModelsDisplayName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q, want /v1/models", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("x-api-key = %q, want sk-test", r.Header.Get("x-api-key"))
		}
		if r.Header.Get("anthropic-version") == "" {
			t.Error("anthropic-version header missing")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[
			{"type":"model","id":"claude-opus-4-8","display_name":"Claude Opus 4.8","created_at":"2026-01-01T00:00:00Z"},
			{"type":"model","id":"claude-fable-5-1","display_name":"Claude Fable 5.1","created_at":"2026-08-28T00:00:00Z"}
		]}`)
	}))
	defer srv.Close()

	models, err := fetchAnthropicModels(srv.URL, "sk-test")
	if err != nil {
		t.Fatalf("fetch error: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %d, want 2", len(models))
	}
	byID := make(map[string]types.ModelEntry)
	for _, m := range models {
		if m.ProviderID != "anthropic" {
			t.Errorf("model %q providerId = %q, want anthropic", m.ID, m.ProviderID)
		}
		byID[m.ID] = m
	}
	if byID["claude-opus-4-8"].DisplayName != "Claude Opus 4.8" {
		t.Errorf("opus-4-8 displayName = %q, want Claude Opus 4.8", byID["claude-opus-4-8"].DisplayName)
	}
	if byID["claude-fable-5-1"].DisplayName != "Claude Fable 5.1" {
		t.Errorf("fable-5-1 displayName = %q, want Claude Fable 5.1", byID["claude-fable-5-1"].DisplayName)
	}
}

// TestDiscoveryStockPayloadUnchanged verifies plain {data:[{id}]} payloads
// (stock providers) still decode with zero-value extended fields.
func TestDiscoveryStockPayloadUnchanged(t *testing.T) {
	var gotBearer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBearer = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"object":"list","data":[{"id":"llama-3.3-70b"},{"id":"mixtral-8x7b"}]}`)
	}))
	defer srv.Close()

	models, err := fetchModelsForProvider("groq", srv.URL+"/openai/v1", "gsk-key", "")
	if err != nil {
		t.Fatalf("fetch error: %v", err)
	}
	// Empty authHeader style defaults to Bearer (previous behavior preserved).
	if gotBearer != "Bearer gsk-key" {
		t.Errorf("Authorization = %q, want Bearer gsk-key", gotBearer)
	}
	if len(models) != 2 {
		t.Fatalf("models = %d, want 2", len(models))
	}
	for _, m := range models {
		if m.Dialect != "" || m.CostPerImage != 0 || m.ThinkingMode != "" {
			t.Errorf("stock entry %q gained unexpected extended fields: %+v", m.ID, m)
		}
		if m.ProviderID != "groq" {
			t.Errorf("providerId = %q, want groq", m.ProviderID)
		}
	}
}

// TestDiscoveryRegistersFullMetadataAndQualifiedIDs verifies storeResult
// registers discovered models with full metadata, and that dialect-carrying
// (gateway) models also register a provider-qualified id without stomping a
// bare id another provider already owns.
func TestDiscoveryRegistersFullMetadataAndQualifiedIDs(t *testing.T) {
	ResetDiscoveryCache()
	t.Cleanup(func() {
		ResetDiscoveryCache()
		mu.Lock()
		delete(modelRegistry, "test-gw/claude-opus-4-6")
		delete(modelRegistry, "test-gw/brand-new-model")
		delete(modelRegistry, "brand-new-model")
		mu.Unlock()
	})

	// claude-opus-4-6's bare id is owned by the anthropic catalog entry.
	preOwner := GetModelInfo("claude-opus-4-6")
	if preOwner == nil || preOwner.ProviderID != "anthropic" {
		t.Fatalf("precondition: claude-opus-4-6 should be owned by anthropic, got %+v", preOwner)
	}

	storeResult("test-gw", []types.ModelEntry{
		{
			ID: "claude-opus-4-6", ProviderID: "test-gw", Dialect: "anthropic",
			ContextWindow: 1000000, CostPer1kInput: 0.005, CostPer1kOutput: 0.025,
		},
		{
			ID: "brand-new-model", ProviderID: "test-gw", Dialect: "openai-chat",
			ContextWindow: 64000,
		},
	}, nil)

	// Bare id owned by another provider is untouched.
	if got := GetModelInfo("claude-opus-4-6"); got.ProviderID != "anthropic" {
		t.Errorf("bare id stomped: providerId = %q, want anthropic", got.ProviderID)
	}
	// Qualified id registered with full metadata.
	q := GetModelInfo("test-gw/claude-opus-4-6")
	if q == nil {
		t.Fatal("qualified id test-gw/claude-opus-4-6 not registered")
	}
	if q.ProviderID != "test-gw" || q.Dialect != "anthropic" || q.ContextWindow != 1000000 {
		t.Errorf("qualified metadata = %+v", q)
	}
	// Unclaimed bare id registered with full metadata.
	b := GetModelInfo("brand-new-model")
	if b == nil || b.ProviderID != "test-gw" || b.Dialect != "openai-chat" || b.ContextWindow != 64000 {
		t.Errorf("bare unclaimed registration = %+v", b)
	}
}

// TestResolveProviderQualifiedID verifies provider-prefix routing and that
// OpenRouter-style ids (slash is part of the wire id) are unaffected.
func TestResolveProviderQualifiedID(t *testing.T) {
	RegisterProvider(&mockProvider{id: "test-gw2"})
	mu.Lock()
	modelRegistry["deepseek/deepseek-chat"] = types.ModelInfo{ProviderID: "openrouter"}
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		delete(providerRegistry, "test-gw2")
		delete(modelRegistry, "deepseek/deepseek-chat")
		mu.Unlock()
	})

	// Qualified id routes to the named provider even with no registry entry.
	if p := ResolveProvider("test-gw2/some-model"); p == nil || p.ID() != "test-gw2" {
		t.Errorf("qualified id resolution failed: %v", p)
	}
	// OpenRouter-style id resolves via exact registry hit, not prefix.
	if p := ResolveProvider("deepseek/deepseek-chat"); p == nil || p.ID() != "openrouter" {
		if p != nil {
			t.Errorf("openrouter id misrouted to %q", p.ID())
		}
		// p == nil acceptable only if openrouter provider is unregistered in
		// this test run — the registry hit determines the provider id.
	}
}

// TestStripProviderQualifier covers the wire-model strip contract.
func TestStripProviderQualifier(t *testing.T) {
	cases := []struct{ provider, model, want string }{
		{"dci-marketing", "dci-marketing/claude-opus-4-8", "claude-opus-4-8"},
		{"dci-marketing", "claude-opus-4-8", "claude-opus-4-8"},
		{"dci-marketing", "deepseek/deepseek-chat", "deepseek/deepseek-chat"},
		{"openrouter", "openrouter/auto", "auto"},
	}
	for _, c := range cases {
		if got := StripProviderQualifier(c.provider, c.model); got != c.want {
			t.Errorf("StripProviderQualifier(%q, %q) = %q, want %q", c.provider, c.model, got, c.want)
		}
	}
}

// TestGatewayProviderDialectDispatch verifies per-model dialect routing: an
// anthropic-dialect model hits /v1/messages, an openai-chat model hits
// /v1/chat/completions, an openai-responses model hits /v1/responses — all on
// the same gateway baseURL with the same auth header.
func TestGatewayProviderDialectDispatch(t *testing.T) {
	paths := make(chan string, 3)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		if r.Header.Get("x-api-key") != "gw-key" {
			t.Errorf("auth header missing on %s", r.URL.Path)
		}
		// Minimal valid SSE close for each dialect.
		w.Header().Set("Content-Type", "text/event-stream")
		switch r.URL.Path {
		case "/v1/messages":
			fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		case "/v1/responses":
			fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")
		default:
			fmt.Fprint(w, "data: [DONE]\n\n")
		}
	}))
	defer srv.Close()

	ResetDiscoveryCache()
	t.Cleanup(func() {
		ResetDiscoveryCache()
		mu.Lock()
		delete(providerRegistry, "test-gw3")
		for _, id := range []string{"gw-claude", "gw-chat", "gw-codex"} {
			delete(modelRegistry, id)
			delete(modelRegistry, "test-gw3/"+id)
		}
		mu.Unlock()
	})

	gw := NewGatewayProvider(CompatibleProviderOptions{
		ID: "test-gw3", APIKey: "gw-key", BaseURL: srv.URL, AuthHeader: "x-api-key",
	})
	RegisterProvider(gw)
	storeResult("test-gw3", []types.ModelEntry{
		{ID: "gw-claude", ProviderID: "test-gw3", Dialect: "anthropic"},
		{ID: "gw-chat", ProviderID: "test-gw3", Dialect: "openai-chat"},
		{ID: "gw-codex", ProviderID: "test-gw3", Dialect: "openai-responses"},
	}, nil)

	wantPaths := map[string]string{
		"gw-claude": "/v1/messages",
		"gw-chat":   "/v1/chat/completions",
		"gw-codex":  "/v1/responses",
	}
	for model, wantPath := range wantPaths {
		events, errc := gw.Stream(t.Context(), types.LlmStreamOptions{
			Model:    model,
			Messages: []types.LlmMessage{{Role: "user", Content: "hi"}},
		})
		for range events { //nolint:revive // drain
		}
		<-errc // errors acceptable (mock responses are minimal); path is the assertion
		gotPath := <-paths
		if gotPath != wantPath {
			t.Errorf("model %q hit %q, want %q", model, gotPath, wantPath)
		}
	}

	// Qualified id strips to the bare wire model and routes by dialect.
	events, errc := gw.Stream(t.Context(), types.LlmStreamOptions{
		Model:    "test-gw3/gw-claude",
		Messages: []types.LlmMessage{{Role: "user", Content: "hi"}},
	})
	for range events { //nolint:revive // drain
	}
	<-errc
	if gotPath := <-paths; gotPath != "/v1/messages" {
		t.Errorf("qualified id hit %q, want /v1/messages", gotPath)
	}
}

// TestStoreResultPreservesCatalogMetadata is the regression guard for the
// registry-clobber defect: storeResult must MERGE live discovery onto the
// existing registry entry, never replace it.
//
// A stock provider's /models payload is ids only, so every extended field
// decodes as zero. Replacing the registry entry with that sparse struct
// destroys the embedded-catalog metadata that GetModelInfo serves — and
// cost.TurnCost reads GetModelInfo directly (not ListModels), so a clobbered
// entry silently prices every turn on that provider at $0. The cache-pricing
// exact cache-pricing fields are included in that preservation contract.
func TestStoreResultPreservesCatalogMetadata(t *testing.T) {
	ResetDiscoveryCache()

	// Seed a catalog-shaped registry entry, including exact cache-pricing fields.
	const model = "clobber-probe-model"
	seeded := types.ModelInfo{
		ProviderID:             "anthropic",
		ContextWindow:          1000000,
		CostPer1kInput:         0.015,
		CostPer1kOutput:        0.075,
		CostPer1kCacheCreation: 0.01875,
		CostPer1kCacheRead:     0.0015,
		MaxOutputTokens:        64000,
		SupportsCaching:        true,
		SupportsThinking:       true,
		SupportsImages:         true,
		ThinkingMode:           "adaptive",
		ThinkingEfforts:        []string{"low", "medium", "high"},
		Tokenizer:              "cl100k_base",
	}
	RegisterModel(model, seeded)
	t.Cleanup(func() {
		ResetDiscoveryCache()
		UnregisterModel(model)
	})

	// Stock-shaped rediscovery by the SAME provider: id only, no metadata.
	storeResult("anthropic", []types.ModelEntry{{ID: model, ProviderID: "anthropic"}}, nil)

	got := GetModelInfo(model)
	if got == nil {
		t.Fatalf("model %q vanished from the registry after discovery", model)
	}
	if got.CostPer1kInput != seeded.CostPer1kInput || got.CostPer1kOutput != seeded.CostPer1kOutput {
		t.Errorf("catalog token pricing clobbered: in=%v out=%v want in=%v out=%v",
			got.CostPer1kInput, got.CostPer1kOutput, seeded.CostPer1kInput, seeded.CostPer1kOutput)
	}
	if got.CostPer1kCacheCreation != seeded.CostPer1kCacheCreation || got.CostPer1kCacheRead != seeded.CostPer1kCacheRead {
		t.Errorf("cache pricing clobbered: create=%v read=%v want create=%v read=%v",
			got.CostPer1kCacheCreation, got.CostPer1kCacheRead, seeded.CostPer1kCacheCreation, seeded.CostPer1kCacheRead)
	}
	if got.ContextWindow != seeded.ContextWindow {
		t.Errorf("ContextWindow clobbered: got %d want %d", got.ContextWindow, seeded.ContextWindow)
	}
	if got.MaxOutputTokens != seeded.MaxOutputTokens {
		t.Errorf("MaxOutputTokens clobbered: got %d want %d", got.MaxOutputTokens, seeded.MaxOutputTokens)
	}
	if !got.SupportsCaching || !got.SupportsThinking || !got.SupportsImages {
		t.Errorf("capability flags clobbered: caching=%v thinking=%v images=%v",
			got.SupportsCaching, got.SupportsThinking, got.SupportsImages)
	}
	if got.ThinkingMode != seeded.ThinkingMode || len(got.ThinkingEfforts) != 3 {
		t.Errorf("thinking metadata clobbered: mode=%q efforts=%v", got.ThinkingMode, got.ThinkingEfforts)
	}
	if got.Tokenizer != seeded.Tokenizer {
		t.Errorf("Tokenizer clobbered: got %q want %q", got.Tokenizer, seeded.Tokenizer)
	}
}

// TestStoreResultLiveMetadataWinsOverExisting is the other half of the merge
// contract: an extended (gateway) payload is authoritative and MUST override
// stale registry values. Without this, the clobber fix could over-correct into
// "existing always wins" and gateway pricing would never take effect.
func TestStoreResultLiveMetadataWinsOverExisting(t *testing.T) {
	ResetDiscoveryCache()

	const model = "live-wins-probe-model"
	RegisterModel(model, types.ModelInfo{
		ProviderID:      "dci-marketing",
		ContextWindow:   8000,
		CostPer1kInput:  0.99,
		CostPer1kOutput: 9.99,
		ThinkingMode:    "none",
	})
	t.Cleanup(func() {
		ResetDiscoveryCache()
		UnregisterModel(model)
		UnregisterModel("dci-marketing/" + model)
	})

	storeResult("dci-marketing", []types.ModelEntry{{
		ID:               model,
		ProviderID:       "dci-marketing",
		Dialect:          "openai-responses",
		ContextWindow:    400000,
		CostPer1kInput:   0.00175,
		CostPer1kOutput:  0.014,
		SupportsThinking: true,
		ThinkingMode:     "reasoning_effort",
		ThinkingEfforts:  []string{"low", "high"},
	}}, nil)

	got := GetModelInfo(model)
	if got == nil {
		t.Fatalf("model %q missing after discovery", model)
	}
	if got.ContextWindow != 400000 {
		t.Errorf("live ContextWindow lost: got %d want 400000", got.ContextWindow)
	}
	if got.CostPer1kInput != 0.00175 || got.CostPer1kOutput != 0.014 {
		t.Errorf("live pricing lost: in=%v out=%v want 0.00175/0.014", got.CostPer1kInput, got.CostPer1kOutput)
	}
	if got.Dialect != "openai-responses" {
		t.Errorf("live Dialect lost: got %q", got.Dialect)
	}
	if got.ThinkingMode != "reasoning_effort" || len(got.ThinkingEfforts) != 2 {
		t.Errorf("live thinking metadata lost: mode=%q efforts=%v", got.ThinkingMode, got.ThinkingEfforts)
	}
	// The qualified alias carries the same live metadata.
	qualified := GetModelInfo("dci-marketing/" + model)
	if qualified == nil {
		t.Fatal("qualified id not registered for a dialect-carrying model")
	}
	if qualified.CostPer1kInput != 0.00175 || qualified.Dialect != "openai-responses" {
		t.Errorf("qualified alias metadata wrong: in=%v dialect=%q", qualified.CostPer1kInput, qualified.Dialect)
	}
}
