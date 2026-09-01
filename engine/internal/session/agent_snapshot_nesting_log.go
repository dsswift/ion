package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// logAgentSnapshotNesting records the nesting attribution of every agent in an
// emitted snapshot: the exact fields a client uses to decide whether a row is
// root-level or nested under a parent dispatch.
//
// This exists because the snapshot emission was a diagnostic blind spot.
// `agent_snapshot_emitted` logged only a COUNT, and `dispatchParentId` -- the
// single field the desktop groups children by (agent-helpers.ts childAgentsOf)
// -- was never logged anywhere in the engine. So when an operator reported that
// a dispatch's drill-down showed no child agents, the question "does the
// nesting data reach the client at all, or does the client drop it?" could not
// be answered from logs. It was answered by guessing, wrongly, three times.
//
// The engine is headless: a payload that is emitted but never described is
// indistinguishable from one that was never emitted. Per the repository's
// logging policy that is a defect on its own, independent of whether the
// underlying behavior turns out to be correct.
//
// Level choice is load-bearing, and the first attempt got it wrong. Per-agent
// detail was written at DEBUG "because this is a high-frequency path" -- but the
// engine's default level is INFO and the level gate runs BEFORE the log sink,
// so those lines would never have reached an operator's engine.jsonl. The
// instrumentation would have been invisible in exactly the situation it exists
// for: diagnosing a live nesting complaint without asking the operator to
// reconfigure and reproduce.
//
// So the per-agent line is INFO, but it is emitted ONLY for an agent that
// carries nesting attribution (or should and does not). A root-level roster
// entry adds nothing to a nesting question and would be pure volume on every
// heartbeat tick; a nested entry appears only when a dispatch dispatches, which
// is rare. The aggregate summary is INFO always, and WARN when a nested agent
// arrives with no parent id, because that is the shape that makes a child
// render at the root instead of under its parent.
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
