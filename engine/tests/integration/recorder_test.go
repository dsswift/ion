//go:build integration

package integration

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/recorder"
)

// ─── Recorder: Basic recording ───

func TestRecorderStartAndRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "recording.ndjson")

	r, err := recorder.New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	// Record several messages.
	for i := 0; i < 5; i++ {
		if err := r.Record(map[string]interface{}{
			"type": "engine_text_delta",
			"text": "chunk",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	if r.MessageCount() != 5 {
		t.Errorf("expected count=5, got %d", r.MessageCount())
	}

	r.Close()

	// Verify file contents.
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lines := 0
	for scanner.Scan() {
		lines++
		var m map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			t.Errorf("invalid JSON on line %d: %v", lines, err)
		}
	}
	if lines != 5 {
		t.Errorf("expected 5 lines, got %d", lines)
	}
}

// ─── Recorder: Filter by key ───

func TestRecorderFilterByKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "filtered.ndjson")

	r, err := recorder.New(path, "text_chunk")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	r.Record(map[string]string{"type": "text_chunk", "text": "yes"})
	r.Record(map[string]string{"type": "tool_call", "name": "bash"})
	r.Record(map[string]string{"type": "text_chunk", "text": "also yes"})
	r.Record(map[string]string{"type": "error", "message": "nope"})

	if r.MessageCount() != 2 {
		t.Errorf("expected 2 recorded (filtered), got %d", r.MessageCount())
	}

	r.Close()

	// Verify only matching lines in file.
	data, _ := os.ReadFile(path)
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	lines := 0
	for scanner.Scan() {
		lines++
	}
	if lines != 2 {
		t.Errorf("expected 2 lines in file, got %d", lines)
	}
}

// ─── Recorder: Close is idempotent ───

func TestRecorderCloseIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "close.ndjson")

	r, err := recorder.New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	r.Record(map[string]string{"type": "test"})
	if err := r.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// ─── Recorder: Invalid path ───

func TestRecorderInvalidPath(t *testing.T) {
	_, err := recorder.New("/nonexistent/deeply/nested/path/recording.ndjson", "")
	if err == nil {
		t.Fatal("expected error for invalid path")
	}
}

// ─── Recorder: Message count starts at zero ───

func TestRecorderInitialCount(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.ndjson")

	r, err := recorder.New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	if r.MessageCount() != 0 {
		t.Errorf("expected initial count=0, got %d", r.MessageCount())
	}
}

// ─── Recorder: No key records everything ───

func TestRecorderNoKeyRecordsAll(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "all.ndjson")

	r, err := recorder.New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	r.Record(map[string]string{"type": "a"})
	r.Record(map[string]string{"type": "b"})
	r.Record(map[string]string{"type": "c"})

	if r.MessageCount() != 3 {
		t.Errorf("expected 3, got %d", r.MessageCount())
	}
}
