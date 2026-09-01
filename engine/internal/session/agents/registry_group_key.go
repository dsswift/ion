package agents

// groupKey identifies one row in the emitted agent-state snapshot.
//
// Grouping is keyed by agent name AND the parent dispatch that spawned the
// work. Name alone collapsed every dispatch sharing a name -- across all
// parents and depths -- into one representative row bearing one
// dispatchParentId, so a consumer grouping children by that field could match
// only a single parent and every other parent's drill-down came up empty.
//
// parentID is empty for root-level work, which keeps every root dispatch of a
// given name collapsing exactly as before.
type groupKey struct {
	name     string
	parentID string
}

// dispatchParentIDOf reads the parent dispatch id from an agent's metadata.
//
// Metadata crosses the wire as JSON, so the value is a string when present and
// absent entirely for extension roster rows and root-level dispatches. Both
// resolve to "" and group together, which is the pre-existing behavior for
// unattributed rows.
func dispatchParentIDOf(meta map[string]interface{}) string {
	if meta == nil {
		return ""
	}
	id, _ := meta["dispatchParentId"].(string) //nolint:errcheck // absent or wrong type means root-level
	return id
}
