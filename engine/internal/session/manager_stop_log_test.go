package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// StopSession used to log at INFO *before* looking the session up, so a stop
// for a key the manager has never heard of was indistinguishable in the log
// from a real teardown. A desktop render loop hammering stop_session turned
// that into 109,801 INFO lines for roughly 60 actual stops, which rotated
// engine.jsonl past the window under investigation and destroyed the evidence
// it was being traced from.
//
// So the property is: the INFO line means a session was actually stopped. A
// miss is DEBUG. Both assertions below fail against the pre-fix ordering — the
// first because the miss emitted INFO "stopsession", the second because it
// emitted it before discovering there was nothing to stop.

// Serializes access to the process-global logger sink.
var stopLogMu sync.Mutex

type stopLogEntry struct {
	level utils.LogLevel
	msg   string
}

func captureSessionLogs(t *testing.T) func() []stopLogEntry {
	t.Helper()
	stopLogMu.Lock()

	var mu sync.Mutex
	var entries []stopLogEntry

	prevLevel := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, _ map[string]any, _, _ string) {
		if tag != "session" {
			return
		}
		mu.Lock()
		entries = append(entries, stopLogEntry{level: level, msg: msg})
		mu.Unlock()
	})

	t.Cleanup(func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prevLevel)
		stopLogMu.Unlock()
	})

	return func() []stopLogEntry {
		mu.Lock()
		defer mu.Unlock()
		out := make([]stopLogEntry, len(entries))
		copy(out, entries)
		return out
	}
}

func TestStopSession_UnknownKeyDoesNotLogAtInfo(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	utils.ResetLogRateLimitForTest()
	t.Cleanup(utils.ResetLogRateLimitForTest)

	mgr := NewManager(newMockBackend())
	snapshot := captureSessionLogs(t)

	if err := mgr.StopSession("never-started"); err == nil {
		t.Fatal("StopSession for an unknown key returned nil error")
	}

	for _, e := range snapshot() {
		if e.msg == "stopsession" {
			t.Fatalf("a stop for an unknown key emitted the teardown line at %s; "+
				"a miss must not read as a real stop", e.level.String())
		}
	}
}

func TestStopSession_UnknownKeyLogsAtDebug(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	utils.ResetLogRateLimitForTest()
	t.Cleanup(utils.ResetLogRateLimitForTest)

	mgr := NewManager(newMockBackend())
	snapshot := captureSessionLogs(t)

	if err := mgr.StopSession("never-started"); err == nil {
		t.Fatal("StopSession for an unknown key returned nil error")
	}

	// Quieter is not the same as silent: the miss is still observable, at the
	// level that per-request detail belongs on (AGENTS.md § "Logging policy").
	var found bool
	for _, e := range snapshot() {
		if e.msg == "stopsession for unknown key" {
			if e.level != utils.LevelDebug {
				t.Fatalf("miss logged at %s, want DEBUG", e.level.String())
			}
			found = true
		}
	}
	if !found {
		t.Fatal("a stop for an unknown key produced no log line at all")
	}
}

func TestStopSession_RealStopLogsAtInfo(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	utils.ResetLogRateLimitForTest()
	t.Cleanup(utils.ResetLogRateLimitForTest)

	mgr := NewManager(newMockBackend())
	const key = "stop-logs-at-info"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}

	snapshot := captureSessionLogs(t)
	if err := mgr.StopSession(key); err != nil {
		t.Fatalf("StopSession failed: %v", err)
	}

	// Moving the line after the lookup must not have cost the signal that
	// matters: a real teardown is still an INFO state transition.
	for _, e := range snapshot() {
		if e.msg == "stopsession" && e.level == utils.LevelInfo {
			return
		}
	}
	t.Fatal("a real stop did not log \"stopsession\" at INFO")
}
