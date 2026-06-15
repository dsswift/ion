package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ─── Round-trip tests ─────────────────────────────────────────────────────────

func TestExitBreadcrumb_WriteRunning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	writeRunning(path)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("breadcrumb file not written: %v", err)
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if rec.Status != "running" {
		t.Errorf("status: got %q want %q", rec.Status, "running")
	}
	if rec.Pid != os.Getpid() {
		t.Errorf("pid: got %d want %d", rec.Pid, os.Getpid())
	}
	if rec.StartedAt == 0 {
		t.Error("startedAt should be non-zero")
	}
	if rec.LastBeat == 0 {
		t.Error("lastBeat should be non-zero")
	}
}

func TestExitBreadcrumb_Beat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	writeRunning(path)

	// Capture initial beat time.
	data, _ := os.ReadFile(path)
	var before exitRecord
	_ = json.Unmarshal(data, &before)

	// Small sleep to ensure the timestamp advances.
	time.Sleep(5 * time.Millisecond)
	beat(path)

	data, _ = os.ReadFile(path)
	var after exitRecord
	_ = json.Unmarshal(data, &after)

	if after.LastBeat < before.LastBeat {
		t.Errorf("beat should advance lastBeat: before=%d after=%d", before.LastBeat, after.LastBeat)
	}
	if after.Status != "running" {
		t.Errorf("beat should not change status: got %q", after.Status)
	}
}

func TestExitBreadcrumb_WriteClean(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	writeRunning(path)
	writeClean(path, "terminated")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("breadcrumb not found after writeClean: %v", err)
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if rec.Status != "clean" {
		t.Errorf("status: got %q want %q", rec.Status, "clean")
	}
	if rec.Reason != "terminated" {
		t.Errorf("reason: got %q want %q", rec.Reason, "terminated")
	}
	if rec.ExitedAt == 0 {
		t.Error("exitedAt should be non-zero after writeClean")
	}
}

func TestExitBreadcrumb_WritePanic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	writeRunning(path)
	writePanic(path, "runtime error: index out of range", "goroutine 1 [running]:\nmain.foo()\n\t/foo.go:42")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("breadcrumb not found after writePanic: %v", err)
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if rec.Status != "panic" {
		t.Errorf("status: got %q want %q", rec.Status, "panic")
	}
	if rec.Reason == "" {
		t.Error("reason should be set after writePanic")
	}
	if rec.Stack == "" {
		t.Error("stack should be set after writePanic")
	}
}

// ─── logPriorExit classification tests ───────────────────────────────────────

func TestLogPriorExit_Absent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	// File does not exist; should not panic.
	logPriorExit(path)
}

func TestLogPriorExit_Clean(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	writeRunning(path)
	writeClean(path, "interrupt")
	logPriorExit(path) // should classify as "clean"
}

func TestLogPriorExit_RunningFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	// Write a "running" record with a very recent lastBeat (< 2x beat interval).
	rec := exitRecord{
		Pid:       99999,
		StartedAt: time.Now().Add(-10 * time.Second).UnixMilli(),
		LastBeat:  time.Now().UnixMilli(), // fresh beat
		Status:    "running",
	}
	data, _ := json.Marshal(rec)
	_ = os.WriteFile(path, data, 0o644)
	// PID 99999 is synthetic; should classify as UNCLEAN.
	logPriorExit(path)
}

func TestLogPriorExit_RunningStale(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	// Write a "running" record with a stale lastBeat.
	rec := exitRecord{
		Pid:       99998,
		StartedAt: time.Now().Add(-10 * time.Minute).UnixMilli(),
		LastBeat:  time.Now().Add(-5 * time.Minute).UnixMilli(),
		Status:    "running",
	}
	data, _ := json.Marshal(rec)
	_ = os.WriteFile(path, data, 0o644)
	// Should classify as UNCLEAN + stale annotation.
	logPriorExit(path)
}

func TestLogPriorExit_Panic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	writeRunning(path)
	writePanic(path, "nil pointer dereference", "goroutine 1\nmain.run()")
	logPriorExit(path) // should classify as PANIC
}

// ─── UNCLEAN detection: running + no writeClean ───────────────────────────────

func TestExitBreadcrumb_UncleanDetection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	writeRunning(path)
	// Simulate: process died without calling writeClean.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("breadcrumb not written: %v", err)
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if rec.Status != "running" {
		t.Errorf("without writeClean, status should be 'running': got %q", rec.Status)
	}
	// logPriorExit will classify this as UNCLEAN on the next start.
	logPriorExit(path)
}

// ─── Beat does not clobber clean record ──────────────────────────────────────

func TestExitBreadcrumb_BeatNoClobberClean(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	writeRunning(path)
	writeClean(path, "shutdown")

	// A stray beat call must not overwrite the clean record.
	beat(path)

	data, _ := os.ReadFile(path)
	var rec exitRecord
	_ = json.Unmarshal(data, &rec)
	if rec.Status != "clean" {
		t.Errorf("beat must not overwrite clean record: status=%q", rec.Status)
	}
}

// ─── Stack truncation ─────────────────────────────────────────────────────────

func TestExitBreadcrumb_PanicStackTruncation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")

	bigStack := make([]byte, 8192)
	for i := range bigStack {
		bigStack[i] = 'x'
	}
	writePanic(path, "oom", string(bigStack))

	data, _ := os.ReadFile(path)
	var rec exitRecord
	_ = json.Unmarshal(data, &rec)

	const maxStack = 4096 + len(" ...[truncated]")
	if len(rec.Stack) > maxStack {
		t.Errorf("stack not truncated: len=%d want<=%d", len(rec.Stack), maxStack)
	}
}
