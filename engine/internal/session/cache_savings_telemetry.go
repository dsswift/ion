package session

import (

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// emitCacheSavings emits a cache.savings telemetry event for a completed run
// when prompt caching was used (any cache-read or cache-creation tokens).
//
// extName and extVersion are optional attribution fields (omit-when-empty).
// When extName is non-empty the context carries "extension"; when extVersion
// is also non-empty it carries "extension_version". Old call sites that do not
// have extension identity pass empty strings — those events group as
// "unattributed" in dashboards, which is the designed ADR-019 evolution path.
//
// The savings estimate is: cacheReadTokens * (fullPrice - cacheReadPrice) per
// 1k input tokens. The full input price comes from the model registry's
// CostPer1kInput. The cache-read price is the model's explicit
// CostPer1kCacheRead when the catalog declares one (pricing_source
// "models_json"); otherwise it falls back to 0.1x the full input price — the
// common provider discount — reported as pricing_source "assumed_0.1x". This
// mirrors the fallback cost.TurnCost applies (cost.go), so the savings estimate
// and the billed cost agree on the same per-model cache-read rate.
//
// Nil-safe on telem. Emits nothing when there were no cache tokens.
func emitCacheSavings(telem *telemetry.Collector, model string, usage types.UsageData, key, conversationID, extName, extVersion string) {
	if telem == nil {
		return
	}
	cacheReadTokens := derefInt(usage.CacheReadInputTokens)
	cacheCreateTokens := derefInt(usage.CacheCreationInputTokens)
	if cacheReadTokens == 0 && cacheCreateTokens == 0 {
		return
	}

	fullPricePer1k := 0.0
	cacheReadPricePer1k := 0.0
	pricingSource := "assumed_0.1x"
	if info := providers.GetModelInfo(model); info != nil {
		fullPricePer1k = info.CostPer1kInput
		if info.CostPer1kCacheRead > 0 {
			// The catalog carries an explicit per-model cache-read price: use it
			// and tag the event so the cost dashboard's split-by-pricing-source
			// panel shows a real "models_json" series for this model.
			cacheReadPricePer1k = info.CostPer1kCacheRead
			pricingSource = "models_json"
		} else {
			// No explicit cache-read price: fall back to 10% of the full input
			// price, matching the cost.TurnCost fallback so the estimate and the
			// billed cost agree.
			cacheReadPricePer1k = info.CostPer1kInput * 0.1
		}
	}

	savingsUsd := float64(cacheReadTokens) / 1000.0 * (fullPricePer1k - cacheReadPricePer1k)

	telem.Event(telemetry.CacheSavings, map[string]any{
		// R11: event name is carried by Event.Name; payload.kind removed.
		"model":                   model,
		"cache_read_tokens":       cacheReadTokens,
		"cache_creation_tokens":   cacheCreateTokens,
		"full_price_per_1k_input": fullPricePer1k,
		"cache_read_price_per_1k": cacheReadPricePer1k,
		"savings_usd":             savingsUsd,
		"pricing_source":          pricingSource,
	}, correlationCtxExt(key, conversationID, extName, extVersion))
	utils.LogWithFields(utils.LevelDebug, "session", "cache.savings telemetry emitted", map[string]any{"key": key, "model": model, "cache_read_tokens": cacheReadTokens, "savings_usd": savingsUsd})
}
