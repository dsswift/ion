package telemetry

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// bigEvent produces an event whose serialized line is comfortably over 1 KB so
// a small cap is reachable in a handful of flushes.
func bigEvent(i int) Event {
	return Event{
		Ts:            "2026-08-19T13:00:00.000000000Z",
		Name:          "test.rotate",
		SchemaVersion: TelemetrySchemaVersion,
		Payload:       map[string]any{"i": i, "filler": strings.Repeat("x", 2048)},
	}
}

func TestResolveRotationDefaults(t *testing.T) {
	p := resolveRotation(0, 0, false)
	if p.maxBytes != defaultMaxSizeMB*1024*1024 {
		t.Fatalf("default cap = %d, want %d MB", p.maxBytes, defaultMaxSizeMB)
	}
	if p.maxFiles != defaultMaxFiles {
		t.Fatalf("default archives = %d, want %d", p.maxFiles, defaultMaxFiles)
	}
}

func TestResolveRotationExplicitAndDisabled(t *testing.T) {
	if p := resolveRotation(5, 1, false); p.maxBytes != 5*1024*1024 || p.maxFiles != 1 {
		t.Fatalf("explicit policy = %+v", p)
	}
	if p := resolveRotation(5, 1, true); p.maxBytes != 0 {
		t.Fatalf("DisableRotation must disable: %+v", p)
	}
	if p := resolveRotation(-1, 0, false); p.maxBytes != 0 {
		t.Fatalf("negative cap must disable: %+v", p)
	}
	// Negative MaxFiles means "keep no archives", not "use the default".
	if p := resolveRotation(5, -1, false); p.maxFiles != 0 || p.maxBytes == 0 {
		t.Fatalf("negative archives policy = %+v", p)
	}
}

// The regression test for the unbounded-growth defect: before rotation existed,
// flushToFile appended forever and this file grew past every cap.
func TestFlushToFileRotatesAtCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	// 1 MB cap, 2 archives. Each flush writes ~20 KB.
	policy := resolveRotation(1, 2, false)

	for i := 0; i < 120; i++ {
		events := make([]Event, 0, 10)
		for j := 0; j < 10; j++ {
			events = append(events, bigEvent(i*10+j))
		}
		if err := flushToFile(events, path, policy); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat live file: %v", err)
	}
	// The live file is bounded by the cap plus at most one flush.
	if fi.Size() > policy.maxBytes+64*1024 {
		t.Fatalf("live file is %d bytes, cap is %d — rotation did not fire", fi.Size(), policy.maxBytes)
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("expected archive .1: %v", err)
	}
}

func TestRotationRetainsOnlyMaxFilesArchives(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	policy := resolveRotation(1, 2, false)

	for i := 0; i < 400; i++ {
		if err := flushToFile([]Event{bigEvent(i), bigEvent(i), bigEvent(i), bigEvent(i), bigEvent(i)}, path, policy); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
	}

	for _, n := range []int{1, 2} {
		if _, err := os.Stat(fmt.Sprintf("%s.%d", path, n)); err != nil {
			t.Fatalf("expected archive .%d to exist: %v", n, err)
		}
	}
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Fatalf("archive .3 must not exist with maxFiles=2 (err=%v)", err)
	}

	// Total disk is bounded: live + maxFiles archives, each at roughly the cap.
	var total int64
	for _, p := range []string{path, path + ".1", path + ".2"} {
		if fi, err := os.Stat(p); err == nil {
			total += fi.Size()
		}
	}
	if bound := policy.maxBytes*3 + 128*1024; total > bound {
		t.Fatalf("total telemetry bytes %d exceeds bound %d", total, bound)
	}
}

func TestRotationDisabledGrowsUnbounded(t *testing.T) {
	// Pins the escape hatch: an operator who ships downstream and wants the
	// whole local file keeps it by setting DisableRotation.
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	policy := resolveRotation(1, 2, true)

	for i := 0; i < 120; i++ {
		events := make([]Event, 0, 10)
		for j := 0; j < 10; j++ {
			events = append(events, bigEvent(i*10+j))
		}
		if err := flushToFile(events, path, policy); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Size() < 1024*1024 {
		t.Fatalf("expected an unbounded file over 1 MB, got %d", fi.Size())
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatalf("no archive should exist when rotation is disabled (err=%v)", err)
	}
}

func TestRotationDiscardsWhenNoArchivesRetained(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	policy := resolveRotation(1, -1, false)

	for i := 0; i < 120; i++ {
		events := make([]Event, 0, 10)
		for j := 0; j < 10; j++ {
			events = append(events, bigEvent(i*10+j))
		}
		if err := flushToFile(events, path, policy); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Size() > policy.maxBytes+64*1024 {
		t.Fatalf("live file %d exceeds cap %d", fi.Size(), policy.maxBytes)
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatalf("maxFiles<0 must retain no archives (err=%v)", err)
	}
}

// Rotation must not corrupt the stream: every retained line stays valid JSONL
// and the newest lines live in the live file.
func TestRotationPreservesWholeLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	policy := resolveRotation(1, 2, false)

	for i := 0; i < 200; i++ {
		if err := flushToFile([]Event{bigEvent(i), bigEvent(i), bigEvent(i), bigEvent(i), bigEvent(i)}, path, policy); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
	}

	for _, p := range []string{path, path + ".1", path + ".2"} {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		events := mustReadTelemetryFile(t, p)
		for _, event := range events {
			if event.Name != "test.rotate" {
				t.Fatalf("%s: unexpected event name %q", p, event.Name)
			}
		}
	}
}

// A collector built from operator config must carry the rotation through to the
// file it writes — the config field is not decoration.
func TestCollectorFlushHonorsConfiguredRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	c := NewCollector(types.TelemetryConfig{
		Enabled:   true,
		Targets:   []string{"file"},
		FilePath:  path,
		MaxSizeMB: 1,
		MaxFiles:  1,
	})
	defer c.Close()

	// Enough volume to pass the 1 MB cap several times over, so the assertion
	// below fails outright if the collector drops the policy on the floor.
	for i := 0; i < 1500; i++ {
		c.Event("test.rotate", map[string]any{"i": i, "filler": strings.Repeat("x", 2048)}, nil)
		if err := c.Flush(); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Size() > 1024*1024+64*1024 {
		t.Fatalf("collector file %d bytes exceeds its 1 MB cap", fi.Size())
	}
	if _, err := os.Stat(path + ".2"); !os.IsNotExist(err) {
		t.Fatalf("maxFiles=1 must retain one archive only (err=%v)", err)
	}
}
