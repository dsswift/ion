package agents

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type clampLogLine struct {
	level  utils.LogLevel
	msg    string
	fields map[string]any
}

// captureClampLines records every clamp log line with its level, starting
// from an empty memo.
func captureClampLines(t *testing.T) func() []clampLogLine {
	t.Helper()
	resetClampLogMemoForTest()
	utils.ResetLogRateLimitForTest()
	prev := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	t.Cleanup(func() { utils.SetLevel(prev) })
	var mu sync.Mutex
	var got []clampLogLine
	utils.SetTestSink(func(level utils.LogLevel, _, msg string, fields map[string]any, _, _ string) {
		if !strings.HasSuffix(msg, "_clamped") {
			return
		}
		mu.Lock()
		got = append(got, clampLogLine{level, msg, fields})
		mu.Unlock()
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })
	return func() []clampLogLine {
		mu.Lock()
		defer mu.Unlock()
		return append([]clampLogLine(nil), got...)
	}
}

func oversizedAgent(name, status string) types.AgentStateUpdate {
	return types.AgentStateUpdate{
		Name: name, Status: status,
		Metadata: map[string]any{"displayName": name, "task": strings.Repeat("x", 6432)},
	}
}

// A clamp that repeats identically must log once; a change in what was
// clamped, or a doubling of the original size, must log again.
func TestFirstClampOccurrence_OncePerSignature(t *testing.T) {
	resetClampLogMemoForTest()
	rep := &ClampReport{Scope: "value", ClampedKeys: []string{"dispatches", "task"}, OriginalBytes: 92_000}
	attr := ClampAttribution{Key: "tab-1", ConversationID: "c1"}

	sig := clampSignature(attr, "ios-dev", rep)
	if !firstClampOccurrence(sig) {
		t.Fatal("first occurrence must log")
	}
	if firstClampOccurrence(sig) {
		t.Fatal("identical repeat must not log again")
	}

	// Same keys, same size class: still silent.
	rep.OriginalBytes = 100_000
	if firstClampOccurrence(clampSignature(attr, "ios-dev", rep)) {
		t.Fatal("a size change inside the same log2 bucket is the same signature")
	}
	// Doubling crosses a bucket: logs again.
	rep.OriginalBytes = 200_000
	if !firstClampOccurrence(clampSignature(attr, "ios-dev", rep)) {
		t.Fatal("a size class change must log again")
	}
	// A different agent on the same session is its own signature.
	if !firstClampOccurrence(clampSignature(attr, "comms", rep)) {
		t.Fatal("another agent must log on its first clamp")
	}
}

func TestFirstClampOccurrence_MemoIsBounded(t *testing.T) {
	resetClampLogMemoForTest()
	for i := 0; i < clampLogMemoCap+10; i++ {
		firstClampOccurrence(clampSignature(ClampAttribution{Key: "k"}, "agent", &ClampReport{OriginalBytes: i + 1, ClampedKeys: []string{string(rune('a' + i%26)), string(rune(i))}}))
	}
	clampLogMu.Lock()
	n := len(clampLogSeen)
	clampLogMu.Unlock()
	if n > clampLogMemoCap {
		t.Fatalf("memo must stay bounded at %d, has %d", clampLogMemoCap, n)
	}
}

// Every heartbeat re-projects the same roster. The clamp still applies and
// still reports each time, but the log carries one line, at any level.
func TestClampLog_RepeatedProjectionWritesOneLine(t *testing.T) {
	read := captureClampLines(t)
	states := []types.AgentStateUpdate{oversizedAgent("code-engineer", "running")}
	attr := ClampAttribution{Key: "tab-1", ConversationID: "c1"}

	for i := 0; i < 50; i++ {
		if _, reports := ClampSnapshotCopy(states, MetadataLimits{}, attr); len(reports) != 1 {
			t.Fatalf("projection %d: want 1 clamp report, got %d", i, len(reports))
		}
	}

	lines := read()
	if len(lines) != 1 {
		t.Fatalf("want 1 clamp log line across 50 projections, got %d", len(lines))
	}
	if lines[0].level != utils.LevelWarn {
		t.Errorf("a live agent's first clamp must be WARN, got %v", lines[0].level)
	}
}

// A live agent that then finishes with the same oversized value is the same
// condition: no second line.
func TestClampLog_TerminalTransitionDoesNotRelog(t *testing.T) {
	read := captureClampLines(t)
	attr := ClampAttribution{Key: "tab-1", ConversationID: "c1"}

	ClampSnapshotCopy([]types.AgentStateUpdate{oversizedAgent("code-engineer", "running")}, MetadataLimits{}, attr)
	for _, status := range []string{"done", "done", "done"} {
		ClampSnapshotCopy([]types.AgentStateUpdate{oversizedAgent("code-engineer", status)}, MetadataLimits{}, attr)
	}

	if lines := read(); len(lines) != 1 {
		t.Fatalf("want 1 clamp log line, got %d", len(lines))
	}
}

// An agent first seen already terminal (a rehydrated roster) never reaches
// the WARN channel.
func TestClampLog_TerminalAgentNeverWarns(t *testing.T) {
	for _, status := range []string{"done", "error", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			read := captureClampLines(t)
			states := []types.AgentStateUpdate{oversizedAgent("code-engineer", status)}
			for i := 0; i < 5; i++ {
				ClampSnapshotCopy(states, MetadataLimits{}, ClampAttribution{Key: "tab-1"})
			}
			lines := read()
			if len(lines) != 1 {
				t.Fatalf("want 1 clamp log line, got %d", len(lines))
			}
			if lines[0].level != utils.LevelDebug {
				t.Errorf("a terminal agent's clamp must be DEBUG, got %v", lines[0].level)
			}
		})
	}
}

// The roster-tier line follows the same rule as the entry-tier one.
func TestClampLog_RepeatedSnapshotClampWritesOneLine(t *testing.T) {
	read := captureClampLines(t)
	var states []types.AgentStateUpdate
	for i := 0; i < 8; i++ {
		states = append(states, types.AgentStateUpdate{
			Name:     string(rune('a'+i)) + "-agent",
			Metadata: map[string]any{"displayName": strings.Repeat("y", 64*1024)},
		})
	}

	for i := 0; i < 20; i++ {
		ClampSnapshotCopy(states, MetadataLimits{MaxSnapshotBytes: 8 * 1024}, ClampAttribution{Key: "tab-2"})
	}

	n := 0
	for _, line := range read() {
		if line.msg == "agent_snapshot_clamped" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("want 1 agent_snapshot_clamped line across 20 projections, got %d", n)
	}
}
