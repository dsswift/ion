// metadata_clamp_log.go — when a clamp is worth a log line.
//
// The clamp runs on every snapshot projection, and a snapshot is re-projected
// for the life of the session. An agent whose metadata stays oversized is
// therefore clamped identically on every projection, long after it finished.
// One line says everything there is to say about that condition; every later
// line is volume that pushes other records out of the log. So a clamp is
// logged once per signature and a repeat writes nothing at all — not a lower
// level, since a level the operator has enabled is still written.
package agents

import (
	"fmt"
	"math/bits"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// clampLogSeen records which clamp signatures have already been logged.
// Bounded: once it grows past clampLogMemoCap it is reset, so a long-running
// engine re-logs at worst once per cap-worth of distinct signatures rather
// than growing without limit.
var (
	clampLogMu   sync.Mutex
	clampLogSeen = map[string]struct{}{}
)

const clampLogMemoCap = 4096

// isTerminalStatus reports whether an agent's run has ended. Nothing about a
// finished agent's metadata can still be acted on.
func isTerminalStatus(status string) bool {
	return status == "done" || status == "error" || status == "cancelled"
}

// clampSignature identifies "the same clamp happening again": the session,
// the agent, which keys were clamped or dropped, and the size class of the
// original (log2 bucket), so growth by a factor of two logs again while
// steady-state repetition does not. Status is deliberately absent: an agent
// that finishes with the same oversized value is the same condition.
func clampSignature(attr ClampAttribution, agent string, rep *ClampReport) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%d", attr.Key, agent, rep.Scope,
		strings.Join(rep.ClampedKeys, ","), strings.Join(rep.DroppedKeys, ","), sizeBucket(rep.OriginalBytes))
}

// snapshotClampSignature is the roster-tier equivalent: one condition per
// session, roster width, and size class.
func snapshotClampSignature(attr ClampAttribution, agentCount, originalBytes int) string {
	return fmt.Sprintf("%s|snapshot|%d|%d", attr.Key, agentCount, sizeBucket(originalBytes))
}

func sizeBucket(n int) int {
	if n <= 0 {
		return 0
	}
	return bits.Len(uint(n))
}

// firstClampOccurrence reports whether sig has not been logged yet, and
// records it.
func firstClampOccurrence(sig string) bool {
	clampLogMu.Lock()
	defer clampLogMu.Unlock()
	if len(clampLogSeen) >= clampLogMemoCap {
		clampLogSeen = map[string]struct{}{}
	}
	if _, seen := clampLogSeen[sig]; seen {
		return false
	}
	clampLogSeen[sig] = struct{}{}
	return true
}

// logEntryClamp writes the one line for a newly seen entry clamp. A live
// agent's is a WARN: its producer is still running and can be corrected. A
// terminal agent's is DEBUG: it is a record, not a condition to act on.
func logEntryClamp(state *types.AgentStateUpdate, rep *ClampReport, attr ClampAttribution) {
	if !firstClampOccurrence(clampSignature(attr, state.Name, rep)) {
		return
	}
	level := utils.LevelWarn
	if isTerminalStatus(state.Status) {
		level = utils.LevelDebug
	}
	utils.LogWithFields(level, "session.agents", "agent_metadata_clamped", map[string]any{
		"key": attr.Key, "conversation_id": attr.ConversationID,
		"agent": state.Name, "status": state.Status, "scope": rep.Scope,
		"clamped_keys": rep.ClampedKeys, "dropped_keys": rep.DroppedKeys,
		"original_bytes": rep.OriginalBytes, "clamped_bytes": rep.ClampedBytes,
		"limit_bytes": rep.LimitBytes,
	})
}

// logSnapshotClamp writes the one line for a newly seen roster clamp.
func logSnapshotClamp(agentCount int, rep *ClampReport, attr ClampAttribution) {
	if !firstClampOccurrence(snapshotClampSignature(attr, agentCount, rep.OriginalBytes)) {
		return
	}
	utils.LogWithFields(utils.LevelWarn, "session.agents", "agent_snapshot_clamped", map[string]any{
		"key": attr.Key, "conversation_id": attr.ConversationID,
		"agents": agentCount, "dropped_keys": len(rep.DroppedKeys),
		"original_bytes": rep.OriginalBytes, "clamped_bytes": rep.ClampedBytes,
		"limit_bytes": rep.LimitBytes,
	})
}

// resetClampLogMemoForTest clears the memo between tests.
func resetClampLogMemoForTest() {
	clampLogMu.Lock()
	defer clampLogMu.Unlock()
	clampLogSeen = map[string]struct{}{}
}
