package recorder

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecorder_BasicRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.ndjson")

	r, err := New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	msg := map[string]string{"type": "text", "content": "hello"}
	if err := r.Record(msg); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := r.Record(msg); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if r.MessageCount() != 2 {
		t.Errorf("expected count 2, got %d", r.MessageCount())
	}

	r.Close()

	f, _ := os.Open(path)
	defer f.Close()
	scanner := bufio.NewScanner(f)
	lines := 0
	for scanner.Scan() {
		lines++
		var m map[string]string
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			t.Errorf("invalid JSON on line %d: %v", lines, err)
		}
	}
	if lines != 2 {
		t.Errorf("expected 2 lines, got %d", lines)
	}
}

func TestRecorder_KeyFilter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "filtered.ndjson")

	r, err := New(path, "text_chunk")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	r.Record(map[string]string{"type": "text_chunk", "text": "hello"})
	r.Record(map[string]string{"type": "tool_call", "name": "bash"})
	r.Record(map[string]string{"type": "text_chunk", "text": "world"})

	if r.MessageCount() != 2 {
		t.Errorf("expected count 2, got %d", r.MessageCount())
	}

	r.Close()

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

func TestRecorder_EmptyKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "all.ndjson")

	r, err := New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close()

	r.Record(map[string]string{"type": "a"})
	r.Record(map[string]string{"type": "b"})
	r.Record(map[string]string{"type": "c"})

	if r.MessageCount() != 3 {
		t.Errorf("expected count 3, got %d", r.MessageCount())
	}
}

func TestRecorder_Close(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "close.ndjson")

	r, err := New(path, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	r.Record(map[string]string{"type": "test"})
	if err := r.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err := r.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestRecorder_InvalidPath(t *testing.T) {
	_, err := New("/nonexistent/path/to/file.ndjson", "")
	if err == nil {
		t.Fatal("expected error for invalid path")
	}
}
