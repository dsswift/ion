package session

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// nestingLogged remembers what was last described for each session, so a
// snapshot that repeats the previous one (every heartbeat tick does) logs at
// DEBUG and only a change reaches INFO. Keyed by session key; each value maps
// agent id to that agent's description, plus summaryKey for the summary line.
// A snapshot is complete (every live agent), so each call replaces the
// session's entry and it never outgrows the live roster.
var (
	nestingLoggedMu sync.Mutex
	nestingLogged   = map[string]map[string]string{}
)

const summaryKey = "\x00summary"

// emittedCounts is the roster size last logged at INFO per session, for
// agentSnapshotEmittedLevel. Separate from nestingLogged because an empty
// snapshot clears that one and is still worth one INFO line here.
var emittedCounts = map[string]int{}

// agentSnapshotEmittedLevel is INFO for a forced emission or one whose roster
// size differs from the session's previous emission, DEBUG for a repeat (the
// heartbeat tick). Guarded by nestingLoggedMu.
func agentSnapshotEmittedLevel(key string, count int, force bool) utils.LogLevel {
	nestingLoggedMu.Lock()
	defer nestingLoggedMu.Unlock()
	prev, seen := emittedCounts[key]
	emittedCounts[key] = count
	if force || !seen || prev != count {
		return utils.LevelInfo
	}
	return utils.LevelDebug
}

// forgetAgentSnapshotNesting drops a session's remembered snapshot. Called
// with emitted=true when the session stops, which also drops its roster size.
func forgetAgentSnapshotNesting(key string, emitted bool) {
	nestingLoggedMu.Lock()
	delete(nestingLogged, key)
	if emitted {
		delete(emittedCounts, key)
	}
	nestingLoggedMu.Unlock()
}

// nestingLevel reports INFO (or high) when desc differs from what was last
// logged for id in prev, DEBUG when it repeats, and records it in next.
func nestingLevel(prev, next map[string]string, id, desc string, high utils.LogLevel) utils.LogLevel {
	next[id] = desc
	if prev[id] == desc {
		return utils.LevelDebug
	}
	return high
}

// logAgentSnapshotNesting describes the nesting attribution of each
// dispatch-attributed agent in an emitted snapshot: the fields a consumer needs
// to decide whether a row is root-level or nested under a parent dispatch.
//
// It exists because the emission logged only a count. A payload that is emitted
// but never described is indistinguishable from one that was never emitted, so
// "did the nesting data reach the consumer, or did the consumer drop it?" was
// unanswerable from logs alone.
//
// A line whose content changed since the session's previous snapshot is
// emitted at INFO (WARN for missing attribution): DEBUG is below the level a
// consumer install runs at, which would make a change invisible in the
// situation this exists for. A line that only repeats the previous snapshot
// is DEBUG, so a heartbeat tick adds nothing at INFO. Volume is also bounded
// by describing only dispatch-attributed rows: an unattributed roster row adds
// nothing to a nesting question.
//
// A nested row (depth > 1) with no parent id cannot be grouped under anything,
// so it warns -- that is the shape that renders a child at the root.
func logAgentSnapshotNesting(key, reason string, snapshot []types.AgentStateUpdate) {
	if len(snapshot) == 0 {
		forgetAgentSnapshotNesting(key, false)
		return
	}
	// next is filled privately and published whole at the end: a concurrent
	// snapshot for the same key reads the published map as its prev.
	nestingLoggedMu.Lock()
	prev := nestingLogged[key]
	nestingLoggedMu.Unlock()
	next := make(map[string]string, len(snapshot)+1)

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
		entry := map[string]any{
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
		}
		desc := fmt.Sprintf("%s|%s|%s|%d|%t|%v|%v", agent.Name, agent.Status, parentID, depth, depthPresent, entry["visibility"], entry["invited"])
		utils.LogWithFields(nestingLevel(prev, next, agent.ID, desc, utils.LevelInfo), "session.agentstate", "agent snapshot entry nesting", entry)
	}

	fields := map[string]any{
		"key": key, "reason": reason, "count": len(snapshot),
		"root_count": rootCount, "nested_count": nestedCount,
		"missing_attribution": missingAttribution,
	}
	summary := fmt.Sprintf("%d|%d|%d|%d", len(snapshot), rootCount, nestedCount, missingAttribution)
	high, msg := utils.LevelInfo, "agent snapshot nesting summary"
	if missingAttribution > 0 {
		high, msg = utils.LevelWarn, "agent snapshot has nested agents with no parent attribution; consumers will render them at root"
	}
	level := nestingLevel(prev, next, summaryKey, summary, high)
	nestingLoggedMu.Lock()
	nestingLogged[key] = next
	nestingLoggedMu.Unlock()
	utils.LogWithFields(level, "session.agentstate", msg, fields)
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
