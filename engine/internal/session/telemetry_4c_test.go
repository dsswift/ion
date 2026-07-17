package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCacheSavingsTelemetry verifies emitCacheSavings emits a cache.savings
// event when the run used cache reads. Uses a real telemetry.Collector and
// BufferedEvents() so the assertion pins the actual emission. Goes red if the
// emission is removed.
func TestCacheSavingsTelemetry(t *testing.T) {
	// Register a model with a known input price so the savings math is
	// deterministic.
	providers.RegisterModel("cache-savings-model", types.ModelInfo{
		ProviderID:     "test",
		ContextWindow:  200000,
		CostPer1kInput: 0.003,
	})

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	usage := types.UsageData{
		CacheReadInputTokens:     intPtr(10000),
		CacheCreationInputTokens: intPtr(2000),
	}
	emitCacheSavings(col, "cache-savings-model", usage, "sess-cache", "", "", "")

	events := col.BufferedEvents()
	var found *telemetry.Event
	for i := range events {
		if events[i].Name == telemetry.CacheSavings {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected a cache.savings event")
	}
	p := found.Payload
	if p["model"] != "cache-savings-model" {
		t.Errorf("model = %v", p["model"])
	}
	if p["cache_read_tokens"] != 10000 {
		t.Errorf("cache_read_tokens = %v, want 10000", p["cache_read_tokens"])
	}
	if p["cache_creation_tokens"] != 2000 {
		t.Errorf("cache_creation_tokens = %v, want 2000", p["cache_creation_tokens"])
	}
	if p["pricing_source"] != "assumed_0.1x" {
		t.Errorf("pricing_source = %v, want assumed_0.1x", p["pricing_source"])
	}
	// savings = 10000/1000 * (0.003 - 0.0003) = 10 * 0.0027 = 0.027
	sav, ok := p["savings_usd"].(float64)
	if !ok {
		t.Fatalf("savings_usd not a float64: %v", p["savings_usd"])
	}
	if sav < 0.0269 || sav > 0.0271 {
		t.Errorf("savings_usd = %f, want ~0.027", sav)
	}
	if found.Context["session_id"] != "sess-cache" {
		t.Errorf("ctx session_id = %v", found.Context["session_id"])
	}
}

// TestCacheSavingsPricingSourceModelsJSON verifies that when the model catalog
// declares an explicit per-model CostPer1kCacheRead, emitCacheSavings consults
// it: pricing_source is "models_json" and cache_read_price_per_1k is the real
// catalog price (not the assumed 0.1x heuristic). This pins the fix that killed
// the dead models_json branch — the pre-fix code hardcoded pricing_source to
// "assumed_0.1x" and always computed CostPer1kInput*0.1, so this test fails on
// the pre-fix code (pricing_source == "assumed_0.1x", price == 0.0003).
func TestCacheSavingsPricingSourceModelsJSON(t *testing.T) {
	// A model that carries a real cache-read price distinct from 0.1x input.
	// 0.1x input would be 0.0005; the explicit price is 0.0002, so the two
	// paths produce provably different numbers.
	providers.RegisterModel("cache-read-priced-model", types.ModelInfo{
		ProviderID:         "test",
		ContextWindow:      200000,
		CostPer1kInput:     0.005,
		CostPer1kCacheRead: 0.0002,
	})

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	usage := types.UsageData{CacheReadInputTokens: intPtr(10000)}
	emitCacheSavings(col, "cache-read-priced-model", usage, "sess-priced", "", "", "")

	var found *telemetry.Event
	for i, e := range col.BufferedEvents() {
		if e.Name == telemetry.CacheSavings {
			found = &col.BufferedEvents()[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected a cache.savings event")
	}
	p := found.Payload
	if p["pricing_source"] != "models_json" {
		t.Errorf("pricing_source = %v, want models_json (model carries an explicit cache-read price)", p["pricing_source"])
	}
	price, ok := p["cache_read_price_per_1k"].(float64)
	if !ok {
		t.Fatalf("cache_read_price_per_1k not a float64: %v", p["cache_read_price_per_1k"])
	}
	if price != 0.0002 {
		t.Errorf("cache_read_price_per_1k = %v, want 0.0002 (the explicit catalog price, not 0.1x input)", price)
	}
	// savings = 10000/1000 * (0.005 - 0.0002) = 10 * 0.0048 = 0.048
	sav, ok := p["savings_usd"].(float64)
	if !ok {
		t.Fatalf("savings_usd not a float64: %v", p["savings_usd"])
	}
	if sav < 0.0479 || sav > 0.0481 {
		t.Errorf("savings_usd = %f, want ~0.048", sav)
	}
}

// TestCacheSavingsNoCacheTokens verifies no event is emitted when the run used
// no cache tokens.
func TestCacheSavingsNoCacheTokens(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	emitCacheSavings(col, "cache-savings-model", types.UsageData{}, "sess-none", "", "", "")
	for _, e := range col.BufferedEvents() {
		if e.Name == telemetry.CacheSavings {
			t.Fatal("expected no cache.savings event when no cache tokens")
		}
	}
}

// TestCacheSavingsNilCollector verifies emitCacheSavings is a no-op (no panic)
// when the collector is nil.
func TestCacheSavingsNilCollector(t *testing.T) {
	emitCacheSavings(nil, "cache-savings-model", types.UsageData{
		CacheReadInputTokens: intPtr(100),
	}, "sess-nil", "", "", "")
}
