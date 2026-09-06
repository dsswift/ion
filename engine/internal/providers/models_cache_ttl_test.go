package providers

import "testing"

// The prompt-cache lifetime is what decides whether a conversation's cached
// prompt still bills at the cheap read rate. A client cannot derive it from a
// price list, so the engine publishes it — and it must match the cache tier the
// provider actually requests, or every consumer prices idle conversations
// wrongly in the same direction.
func TestCatalogCacheTtl_MatchesTheRequestedTier(t *testing.T) {
	entries := ListModels()
	if len(entries) == 0 {
		t.Fatal("model catalog is empty")
	}

	sawAnthropicCaching := false
	for _, e := range entries {
		switch {
		case e.ProviderID == "anthropic" && e.SupportsCaching:
			sawAnthropicCaching = true
			// formatMessages and the system block both request cache_control
			// type "ephemeral" with no explicit ttl, which is the 5-minute
			// tier. The published lifetime must say exactly that.
			if e.CacheTtlSeconds != AnthropicEphemeralCacheTtlSeconds {
				t.Errorf("%s: cacheTtlSeconds = %d, want %d (the ephemeral tier the provider requests)",
					e.ID, e.CacheTtlSeconds, AnthropicEphemeralCacheTtlSeconds)
			}
		case !e.SupportsCaching:
			// A model that does not cache has no lifetime to publish. Zero is
			// the "undeclared" signal; a non-zero value here would tell a
			// consumer a cache survives when none is ever written.
			if e.CacheTtlSeconds != 0 {
				t.Errorf("%s: non-caching model published cacheTtlSeconds = %d, want 0",
					e.ID, e.CacheTtlSeconds)
			}
		}
	}
	if !sawAnthropicCaching {
		t.Fatal("no caching Anthropic model in the catalog: the assertion above never ran")
	}
}

// An explicit catalog value must win over the derived default, so an operator
// model entry can declare a different cache tier.
func TestCatalogCacheTtl_ExplicitValueWins(t *testing.T) {
	got := catalogCacheTtlSeconds(catalogEntry{
		ProviderID:      "anthropic",
		SupportsCaching: true,
		CacheTtlSeconds: 3600,
	})
	if got != 3600 {
		t.Errorf("explicit ttl = %d, want 3600", got)
	}
}

// Every caching model gets a lifetime, whatever provider serves it.
//
// An enterprise gateway serves models under its own provider id and routinely
// publishes cache rates without a lifetime. Those models previously resolved to
// zero, which consumers read as "no declared lifetime" — so they could not tell
// a live prompt cache from an expired one and had to hedge instead of pricing
// the turn, for exactly the models an enterprise operator runs all day.
func TestResolveCacheTtl_DefaultsForEveryCachingModel(t *testing.T) {
	cases := []struct {
		name     string
		caching  bool
		explicit int
		want     int
	}{
		{"caching model with no declared lifetime", true, 0, DefaultCacheTtlSeconds},
		{"explicit value wins over the default", true, 3600, 3600},
		{"a shorter explicit value is honored too", true, 60, 60},
		{"non-caching model has no lifetime", false, 0, 0},
		{"non-caching model with an explicit value still honors it", false, 900, 900},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveCacheTtlSeconds(tc.caching, tc.explicit)
			if got != tc.want {
				t.Errorf("ResolveCacheTtlSeconds(%v, %d) = %d, want %d",
					tc.caching, tc.explicit, got, tc.want)
			}
		})
	}
}

// The default is the SHORTEST lifetime the major providers offer, not a typical
// one, because the two ways of being wrong are not symmetric: too long quotes
// the cheap read rate for a turn that will be billed at the write rate (up to
// 50x understated), while too short merely overstates the stay-put cost.
//
// Anthropic's ephemeral tier is exactly this long, which is what makes the
// floor safe for the provider this engine sends the most traffic to.
func TestDefaultCacheTtl_IsTheShortestMajorProviderLifetime(t *testing.T) {
	if DefaultCacheTtlSeconds != 300 {
		t.Errorf("DefaultCacheTtlSeconds = %d, want 300 (five minutes)", DefaultCacheTtlSeconds)
	}
	if AnthropicEphemeralCacheTtlSeconds < DefaultCacheTtlSeconds {
		t.Errorf("the Anthropic tier (%d) is shorter than the assumed default (%d): the default would report a dead cache as live",
			AnthropicEphemeralCacheTtlSeconds, DefaultCacheTtlSeconds)
	}
}

// Anthropic's published cache multipliers are 1.25x base input for a 5-minute
// write and 0.1x for a read (0.025x on Fable 5.1 / Mythos 5.1). The catalog
// carries explicit rates; this pins them against the multipliers so a mistyped
// row cannot silently misprice a switch by an order of magnitude.
func TestAnthropicCacheRates_MatchPublishedMultipliers(t *testing.T) {
	// Models whose cache read is 0.025x base rather than the standard 0.1x.
	quarterPointReadRate := map[string]bool{"claude-fable-5-1": true}

	for _, e := range ListModels() {
		if e.ProviderID != "anthropic" || e.CostPer1kInput <= 0 {
			continue
		}
		if e.CostPer1kCacheCreation <= 0 || e.CostPer1kCacheRead <= 0 {
			t.Errorf("%s: caching model must publish explicit cache rates (creation=%v read=%v)",
				e.ID, e.CostPer1kCacheCreation, e.CostPer1kCacheRead)
			continue
		}
		wantCreation := e.CostPer1kInput * 1.25
		if !closeEnough(e.CostPer1kCacheCreation, wantCreation) {
			t.Errorf("%s: cache creation = %v, want %v (1.25x input %v)",
				e.ID, e.CostPer1kCacheCreation, wantCreation, e.CostPer1kInput)
		}
		readMultiplier := 0.1
		if quarterPointReadRate[e.ID] {
			readMultiplier = 0.025
		}
		wantRead := e.CostPer1kInput * readMultiplier
		if !closeEnough(e.CostPer1kCacheRead, wantRead) {
			t.Errorf("%s: cache read = %v, want %v (%vx input %v)",
				e.ID, e.CostPer1kCacheRead, wantRead, readMultiplier, e.CostPer1kInput)
		}
	}
}

// Output pricing is 5x input across the Anthropic line. A row that drifts from
// that ratio is the signature of a stale copy of an earlier model's pricing,
// which is exactly what left several rows at a retired model's rates.
func TestAnthropicOutputPricing_HoldsTheInputRatio(t *testing.T) {
	for _, e := range ListModels() {
		if e.ProviderID != "anthropic" || e.CostPer1kInput <= 0 {
			continue
		}
		want := e.CostPer1kInput * 5
		if !closeEnough(e.CostPer1kOutput, want) {
			t.Errorf("%s: output = %v, want %v (5x input %v)",
				e.ID, e.CostPer1kOutput, want, e.CostPer1kInput)
		}
	}
}

func closeEnough(got, want float64) bool {
	diff := got - want
	if diff < 0 {
		diff = -diff
	}
	return diff < 1e-9
}
