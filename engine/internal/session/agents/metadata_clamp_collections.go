// metadata_clamp_collections.go — the entry-budget phases that act on
// PROTECTED keys, and the dispatch-history retention bound.
//
// The original entry budget (enforceEntryBudget) could only DROP unprotected
// keys. That left a structural hole: a protected key whose value is a
// collection of many small elements — dispatches[] is the production case —
// never trips the per-value string clamp (no single leaf is large) and cannot
// be dropped (it is protected), so the 64 KiB entry bound was unenforceable.
// Production advisories recorded clamped_bytes ABOVE limit_bytes, growing
// monotonically, until a 13-agent roster serialized to 30.7 MB and took down
// a consumer.
//
// Protection governs key RETENTION only — that is what the protectedKeys
// contract has always said. These phases make the code honor it: a protected
// key survives every phase, but its value is shrunk as far as the budget
// requires. After clampEntry returns, approxMapBytes(entry) ≤ MaxEntryBytes is
// a hard invariant, not an aspiration.
package agents

import "github.com/dsswift/ion/engine/internal/utils"

// dispatchesTotalKey carries the pre-truncation dispatch count so a consumer
// can render "showing N of M" when the history array has been cut.
const dispatchesTotalKey = "dispatchesTotal"

// capDispatches bounds the dispatches[] history array to the most recent max
// entries. Dispatch records are appended in dispatch order, so the tail is
// the most recent. Returns true when the array was cut.
//
// This runs at projection time (groupByName) as well as inside the entry
// budget, because retention is a count bound, not a byte bound: 10,000 tiny
// records are as pathological for a complete-snapshot event as one huge
// string, long before the byte tiers notice.
func capDispatches(md map[string]any, maxEntries int) bool {
	if md == nil || maxEntries == LimitsDisabled {
		return false
	}
	d, ok := md["dispatches"].([]any)
	if !ok || len(d) <= maxEntries {
		return false
	}
	total := len(d)
	md["dispatches"] = d[total-maxEntries:]
	md[dispatchesTotalKey] = total
	markTruncated(md, []string{"dispatches"})
	utils.LogWithFields(utils.LevelDebug, "session.agents", "dispatches_capped", map[string]any{
		"total": total, "kept": maxEntries,
	})
	return true
}

// shrinkProtectedCollections is Phase B of the entry budget: shrink the
// VALUES of protected collection keys until the entry fits, largest first.
// Arrays lose elements from the head (keeping the most recent tail); nested
// maps lose their largest inner keys. Scalar protected values are left for
// Phase C. Returns the keys whose values were shrunk.
func shrinkProtectedCollections(md map[string]any, budget int) []string {
	var shrunk []string
	for _, k := range protectedKeysBySize(md) {
		if approxMapBytes(md) <= budget {
			break
		}
		switch v := md[k].(type) {
		case []any:
			if shrinkArrayToFit(md, k, v, budget) {
				shrunk = append(shrunk, k)
			}
		case map[string]any:
			if dropped := enforceEntryBudget(v, protectedValueAllowance(md, k, budget)); len(dropped) > 0 {
				shrunk = append(shrunk, k)
			}
		}
	}
	return shrunk
}

// enforceProtectedGuarantee is Phase C: compact protected values while
// preserving their JSON types. The caller already recorded the affected keys;
// get_agent_state supplies their exact values on demand. Scalars become the
// UTF-8-safe truncation string, maps become empty maps, and dispatches keeps a
// valid array (empty only when even its newest complete member cannot fit).
func enforceProtectedGuarantee(md map[string]any, budget int) []string {
	var clamped []string
	for _, key := range protectedKeysBySize(md) {
		if approxMapBytes(md) <= budget {
			return clamped
		}
		switch value := md[key].(type) {
		case string:
			if value == truncationSuffix {
				continue
			}
			md[key] = truncationSuffix
		case []any:
			// Keep the newest addressable member when possible. If it alone
			// exceeds the entry budget, an empty array is the only type-safe
			// bounded projection; _truncated tells consumers to pull full state.
			if len(value) > 1 {
				md[key] = value[len(value)-1:]
			} else {
				md[key] = []any{}
			}
		case map[string]any:
			md[key] = map[string]any{}
		default:
			// Bool/number values are bounded already.
			continue
		}
		clamped = append(clamped, key)
	}
	return clamped
}

// trimTruncationMarkers keeps marker overhead from violating an otherwise
// satisfied entry budget. _truncated remains the recovery signal; key detail is
// retained only while it fits the bounded broadcast.
func trimTruncationMarkers(md map[string]any, budget int) {
	for approxMapBytes(md) > budget {
		keys, ok := md["_truncatedKeys"].([]string)
		if !ok || len(keys) == 0 {
			break
		}
		md["_truncatedKeys"] = keys[:len(keys)-1]
	}
	if keys, ok := md["_truncatedKeys"].([]string); ok && len(keys) == 0 {
		delete(md, "_truncatedKeys")
	}
}

// shrinkArrayToFit cuts arr (stored at md[key]) from the head so the whole
// map fits the budget, keeping the most recent tail. When even an empty array
// cannot fit, the array is emptied and the caller's later phases handle the
// rest. Returns true when elements were removed.
func shrinkArrayToFit(md map[string]any, key string, arr []any, budget int) bool {
	rest := approxMapBytes(md) - approxValueBytes(arr)
	allowance := budget - rest - (len(dispatchesTotalKey) + 3 + 8) // room for the total stamp
	kept := 0
	used := 2 // array brackets
	for i := len(arr) - 1; i >= 0; i-- {
		size := approxValueBytes(arr[i]) + 1
		if used+size > allowance {
			break
		}
		used += size
		kept++
	}
	if kept >= len(arr) {
		return false
	}
	total := len(arr)
	// dispatch identity is load-bearing. When one complete entry alone exceeds
	// the budget, retain its newest member and allow the projection to exceed
	// the budget rather than publishing an empty or corrupt dispatch index.
	if key == "dispatches" && kept == 0 && total > 0 {
		kept = 1
	}
	md[key] = arr[total-kept:]
	if key == "dispatches" {
		md[dispatchesTotalKey] = total
	}
	return true
}

// protectedKeysBySize returns the protected keys present in md, largest value
// first, deterministically (size desc, then key asc) so identical payloads
// clamp identically on every engine.
func protectedKeysBySize(md map[string]any) []string {
	var keys []string
	for _, k := range sortedKeys(md) {
		if protectedKeys[k] {
			keys = append(keys, k)
		}
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if approxValueBytes(md[keys[j]]) > approxValueBytes(md[keys[i]]) {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

// protectedValueAllowance computes how many bytes key's value may occupy for
// the whole map to fit the budget.
func protectedValueAllowance(md map[string]any, key string, budget int) int {
	rest := approxMapBytes(md) - approxValueBytes(md[key])
	allowance := budget - rest
	if allowance < 0 {
		return 0
	}
	return allowance
}
