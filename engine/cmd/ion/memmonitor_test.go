package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// captureLogs installs a test sink and returns a function that yields the
// captured lines (tag + message + key fields). It removes the sink on cleanup.
func captureLogs(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var lines []string
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		mu.Lock()
		line := tag + ": " + msg
		for k, v := range fields {
			line += " " + k + "=" + fmt.Sprint(v)
		}
		lines = append(lines, line)
		mu.Unlock()
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, len(lines))
		copy(out, lines)
		return out
	}
}

func containsSubstr(lines []string, substr string) bool {
	for _, l := range lines {
		if strings.Contains(l, substr) {
			return true
		}
	}
	return false
}

func TestSampleAndLogMemory_LogsFootprintAndSessions(t *testing.T) {
	get := captureLogs(t)

	// A large limit so we stay well below the warn threshold ⇒ INFO branch.
	limit := int64(64) * 1024 * 1024 * 1024
	sampleAndLogMemory(limit, func() int { return 7 })

	lines := get()
	if !containsSubstr(lines, "memmonitor") {
		t.Fatalf("no memmonitor line logged: %v", lines)
	}
	if !containsSubstr(lines, "sessions=7") {
		t.Fatalf("session count not in log: %v", lines)
	}
	if !containsSubstr(lines, "heap_mb=") || !containsSubstr(lines, "limit_mb=") {
		t.Fatalf("heap/limit fields missing: %v", lines)
	}
	// Below threshold ⇒ no HIGH MEMORY escalation.
	if containsSubstr(lines, "HIGH MEMORY") {
		t.Fatalf("unexpected high-memory escalation below threshold: %v", lines)
	}
}

func TestSampleAndLogMemory_EscalatesPastHighWater(t *testing.T) {
	get := captureLogs(t)

	// Force the warn branch deterministically: sampleAndLogMemory reads its
	// own fresh MemStats snapshot internally, so a limit derived from an
	// earlier separate read (as this test used to do) races the allocator --
	// a GC between the two reads can drop HeapAlloc enough to fall back
	// under warnFraction*limit, exactly the flake observed on Windows CI.
	// limitBytes=1 sidesteps the race entirely: any running Go program's
	// HeapAlloc is far above 0.85 bytes, so the escalation fires regardless
	// of the exact heap size sampleAndLogMemory happens to read.
	sampleAndLogMemory(1, func() int { return 3 })

	lines := get()
	if !containsSubstr(lines, "HIGH MEMORY") {
		t.Fatalf("expected HIGH MEMORY escalation, got: %v", lines)
	}
	if !containsSubstr(lines, "sessions=3") {
		t.Fatalf("session count not in escalated log: %v", lines)
	}
}

func TestSampleAndLogMemory_NilSessionCount(t *testing.T) {
	get := captureLogs(t)
	// nil closure must not panic; reports sessions=0.
	sampleAndLogMemory(64*1024*1024*1024, nil)
	if !containsSubstr(get(), "sessions=0") {
		t.Fatalf("nil session count should report sessions=0")
	}
}
