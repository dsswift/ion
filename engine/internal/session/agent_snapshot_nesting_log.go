package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// logAgentSnapshotNesting describes the nesting attribution of each
// dispatch-attributed agent in an emitted snapshot: the fields a consumer needs
// to decide whether a row is root-level or nested under a parent dispatch.
//
// It exists because the emission logged only a count. A payload that is emitted
// but never described is indistinguishable from one that was never emitted, so
// "did the nesting data reach the consumer, or did the consumer drop it?" was
// unanswerable from logs alone.
//
// Emitted at INFO. DEBUG is below the level a consumer install runs at, which
// would make this invisible in the situation it exists for. Volume is bounded
// by describing only dispatch-attributed rows: an unattributed roster row adds
// nothing to a nesting question and would repeat on every heartbeat tick.
//
// A nested row (depth > 1) with no parent id cannot be grouped under anything,
// so it warns -- that is the shape that renders a child at the root.
func logAgentSnapshotNesting(key, reason string, snapshot []types.AgentStateUpdate) {
	if len(snapshot) == 0 {
		return
	}

	rootCount := 0
	nestedCount := 0
	missingAttribution := 0

	for _, agent := range snapshot {
		parentID := agentMetaString(agent.Metadata, "dispatchParentId")
		depth, depthPresent := agentMetaInt(agent.Metadata, "dispatchDepth")

		switch {
		case parentID != "":
			nestedCount++
		case depthPresent && depth > 1:
			// Depth says nested but no parent id: the row cannot be grouped
			// under anything, so a client renders it at the root. This is
			// exactly how a child "disappears" from its parent's drill-down.
			missingAttribution++
		default:
			rootCount++
		}

		// Only dispatch-attributed rows are described individually. A plain
		// root entry is covered by the summary below.
		if parentID == "" && (!depthPresent || depth <= 0) {
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "session.agentstate", "agent snapshot entry nesting", map[string]any{
			"key":                key,
			"reason":             reason,
			"agent_id":           agent.ID,
			"model":              agent.Name,
			"status":             agent.Status,
			"dispatch_parent_id": parentID,
			"dispatch_depth":     depth,
			"depth_present":      depthPresent,
			"visibility":         agentMetaString(agent.Metadata, "visibility"),
			"invited":            agentMetaBool(agent.Metadata, "invited"),
		})
	}

	fields := map[string]any{
		"key": key, "reason": reason, "count": len(snapshot),
		"root_count": rootCount, "nested_count": nestedCount,
		"missing_attribution": missingAttribution,
	}
	if missingAttribution > 0 {
		utils.LogWithFields(utils.LevelWarn, "session.agentstate", "agent snapshot has nested agents with no parent attribution; consumers will render them at root", fields)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.agentstate", "agent snapshot nesting summary", fields)
}

// agentMetaString reads a string metadata value, returning "" when absent or of
// another type. Agent metadata is map[string]interface{} on the wire, so every
// read is a type assertion that must not panic on a malformed entry.
func agentMetaString(meta map[string]interface{}, key string) string {
	if meta == nil {
		return ""
	}
	s, _ := meta[key].(string) //nolint:errcheck // absent or wrong type means "not set"
	return s
}

// agentMetaBool reads a bool metadata value, returning false when absent.
func agentMetaBool(meta map[string]interface{}, key string) bool {
	if meta == nil {
		return false
	}
	b, _ := meta[key].(bool) //nolint:errcheck // absent or wrong type means false
	return b
}

// agentMetaInt reads a numeric metadata value and reports whether it was
// present.
//
// JSON round-trips numbers as float64, but a value set in-process is still an
// int, so both must be accepted. Present-but-zero differs meaningfully from
// absent: zero is the orchestrator tier, absent is an entry with no dispatch
// attribution at all (an extension roster row).
func agentMetaInt(meta map[string]interface{}, key string) (int, bool) {
	if meta == nil {
		return 0, false
	}
	switch v := meta[key].(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	default:
		return 0, false
	}
}
