package agents

// registry_group_by_name.go -- the emitted-snapshot grouping projection.
//
// Extracted from registry.go at its natural seam when that file crossed the
// 800-line cap. groupByName and its grouping key (registry_group_key.go) are
// one concern: how the ID-keyed internal store is projected into the rows a
// consumer receives.

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// groupByName merges entries into one AgentStateUpdate per (agent name, parent
// dispatch). Projection-only: it builds new entries from copies, never mutating
// the source slice or aliasing its metadata maps.
//
// The key is name plus dispatchParentId. Name alone collapsed every dispatch
// sharing an agent name into one row carrying one dispatchParentId, so a
// consumer keying on that field could resolve only a single parent. Same name
// under the same parent still collapses -- that is the duplicate-row case this
// projection exists to prevent.
//
// Per group:
//   - dispatches[] from every entry is merged (order preserved), then bounded
//     to maxDispatchEntries with a dispatchesTotal stamp (see capDispatches).
//     The ID-keyed store keeps every record; only this projection is bounded.
//   - The representative is chosen by representativeBeats.
func groupByName(states []types.AgentStateUpdate, maxDispatchEntries int) []types.AgentStateUpdate {
	if len(states) == 0 {
		return nil
	}

	// Preserve insertion order via an ordered key list. The key is
	// name + parent dispatch id (see the doc comment): same name under one
	// parent collapses, the same name under different parents does not.
	var keyOrder []groupKey
	groups := make(map[groupKey][]int)
	for i, s := range states {
		k := groupKey{name: s.Name, parentID: dispatchParentIDOf(s.Metadata)}
		if _, exists := groups[k]; !exists {
			keyOrder = append(keyOrder, k)
		}
		groups[k] = append(groups[k], i)
	}

	out := make([]types.AgentStateUpdate, 0, len(keyOrder))
	for _, key := range keyOrder {
		indices := groups[key]
		name := key.name

		// Single entry: deep-copy metadata and emit directly.
		if len(indices) == 1 {
			single := copyAgentState(states[indices[0]])
			capDispatches(single.Metadata, maxDispatchEntries)
			// Ensure each dispatch member in the snapshot carries an explicit,
			// non-empty dispatchId (plus dispatchParentId/dispatchDepth/status)
			// so a consumer can address individual dispatches even for a
			// single-dispatch agent. Additive: existing keys ("id", etc.) are
			// left intact; this only fills the identity fields.
			ensureDispatchIdentitiesInMeta(single.Metadata)
			// A single entry that carries dispatch metadata (a task) but no
			// dispatches[] array is the pathological shape a consumer cannot
			// expand: a representative row whose metadata.dispatches[] is empty.
			// Surface it so
			// the symptom has a greppable signature.
			if isDispatchBearing(single.Metadata) && dispatchesLen(single.Metadata) == 0 {
				utils.LogWithFields(utils.LevelDebug, "session.agents", "groupbyname: single entry has dispatch task but empty dispatches[] (consumers cannot expand per-dispatch detail)", map[string]any{"model": name, "status": single.Status})
			}
			out = append(out, single)
			continue
		}

		// Multiple entries: pick the representative.
		//
		// Live work outranks terminal work, so a running dispatch is what the
		// operator sees while it runs. Among entries of EQUAL liveness the most
		// recently started wins, which is what the doc comment above has always
		// promised and what the code did not do.
		//
		// The previous rule ranked statuses against each other (running 4,
		// suspended 3, error 2, done 1). Between two finished dispatches of one name
		// that made an OLD FAILED run permanently outrank a NEW SUCCESSFUL one:
		// error=2 beats done=1 regardless of age. The representative row then
		// carried the stale dispatch's displayName, task, and lastWork, so the
		// operator's just-completed dispatch was absent from the agent panel
		// while a hours-old failure held its slot.
		//
		// Observed live: three "agent-1" dispatches at 16:36, 18:36 and 21:20 in
		// one session. The 21:20 run finished `done`; the 18:36 run had finished
		// `error`. Every snapshot after 21:21 emitted the 18:36 row.
		bestIdx := indices[0]
		for _, idx := range indices[1:] {
			if representativeBeats(states[idx], states[bestIdx]) {
				bestIdx = idx
			}
		}

		representative := copyAgentState(states[bestIdx])

		// Merge dispatches[] from all entries in order, de-duplicating by
		// each dispatch's stable "id". Without this de-dup the projection is
		// not idempotent: re-grouping an array that already carries an
		// instance (e.g. after a persist -> rehydrate round-trip that restored
		// the same dispatch into more than one slot) would append it again,
		// growing the array by one copy per cycle. Keying on "id" counts each
		// instance exactly once regardless of how many slots reference it.
		// Entries with no usable "id" fall back to append so malformed members
		// are preserved rather than silently dropped.
		var mergedDispatches []interface{}
		seenDispatchIDs := make(map[string]bool)
		for _, idx := range indices {
			src := states[idx].Metadata
			if src == nil {
				continue
			}
			if d, ok := src["dispatches"].([]interface{}); ok {
				for _, entry := range d {
					if id, ok := dispatchEntryID(entry); ok {
						if seenDispatchIDs[id] {
							continue
						}
						seenDispatchIDs[id] = true
					}
					member := deepCopyDispatch(entry)
					// Preserve per-dispatch identity in the collapsed snapshot:
					// stamp an explicit dispatchId (mirrored from the stable
					// "id") plus dispatchParentId/dispatchDepth/status onto each
					// member. Same-name dispatches that share a representative
					// row therefore remain distinct, ID-addressable entries in
					// the emitted dispatches[] rather than collapsing into an
					// anonymous blob. Additive only — no existing key is removed.
					ensureDispatchIdentity(member)
					mergedDispatches = append(mergedDispatches, member)
				}
			}
		}
		if representative.Metadata == nil {
			representative.Metadata = map[string]interface{}{}
		}
		if len(mergedDispatches) > 0 {
			representative.Metadata["dispatches"] = mergedDispatches
			capDispatches(representative.Metadata, maxDispatchEntries)
		}

		// Observability: a same-name group that collapses N entries into one
		// representative is where dispatch rows can be lost. Log the chosen
		// representative's status and the merged dispatches[] length; flag the
		// case where a dispatch-bearing group still projects to an empty
		// dispatches[] (the empty-detail symptom).
		if isDispatchBearing(representative.Metadata) && len(mergedDispatches) == 0 {
			utils.LogWithFields(utils.LevelDebug, "session.agents", "groupbyname: merged dispatches[] is empty despite dispatch task (consumers cannot expand per-dispatch detail)", map[string]any{"model": name, "count": len(indices), "status": representative.Status})
		} else {
			utils.LogWithFields(utils.LevelDebug, "session.agents", "groupbyname", map[string]any{"agent_name": name, "index_count": len(indices), "status": representative.Status, "merged_dispatch_count": len(mergedDispatches)})
		}

		out = append(out, representative)
	}
	return out
}
