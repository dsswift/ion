package backend

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// End-to-end proof of the fix, through the real dispatch path.
//
// A Windows endpoint reported "Read returns stale content after Edit" three
// separate times, the last run reproducing it 4 of 4 attempts. Read has no
// cache; every reported occurrence had the Edit and the Read sharing one
// assistant-block timestamp, so they were siblings in one response and ran
// concurrently. Whichever won decided what the model was told.
//
// Run with -race and repeated: without the ordering this fails intermittently,
// which is exactly why it read as a flaky cache rather than a race.
func TestBatchedEditAndReadObservesTheWrite(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "note.txt")
	if err := os.WriteFile(path, []byte("line one\nline two\nline three\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "order-req",
		conv:      &conversation.Conversation{ID: "conv-order"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}},
	}

	// Exactly what the diagnostic did: one response, both calls, Edit first.
	blocks := []types.LlmContentBlock{
		{
			Type: "tool_use",
			Name: "Edit",
			ID:   "tc-edit",
			Input: map[string]interface{}{
				"file_path":  path,
				"old_string": "line two",
				"new_string": "line two EDITED",
			},
		},
		{
			Type:  "tool_use",
			Name:  "Read",
			ID:    "tc-read",
			Input: map[string]interface{}{"file_path": path},
		},
	}

	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatalf("executeTools: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("result count = %d, want 2", len(results))
	}

	// results[1] is the Read. It must show the edit the sibling Edit made.
	readOut := results[1].Content
	if !strings.Contains(readOut, "line two EDITED") {
		t.Errorf("the batched Read did not observe its sibling Edit.\nRead returned:\n%s", readOut)
	}

	// And the disk must agree — proving this is ordering, not a Read that
	// invented the new content.
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "line two EDITED") {
		t.Errorf("disk content = %q, want the edit applied", string(onDisk))
	}
}

// The reverse order must be honoured too: a model that reads THEN writes in one
// response is asking for the pre-write content, and must get it.
func TestBatchedReadBeforeWriteSeesTheOriginal(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "note.txt")
	if err := os.WriteFile(path, []byte("original\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "order-req-2",
		conv:      &conversation.Conversation{ID: "conv-order-2"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}},
	}

	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "Read", ID: "tc-read", Input: map[string]interface{}{"file_path": path}},
		{
			Type: "tool_use",
			Name: "Write",
			ID:   "tc-write",
			Input: map[string]interface{}{
				"file_path": path,
				"content":   "replaced\n",
			},
		},
	}

	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatalf("executeTools: %v", err)
	}
	if !strings.Contains(results[0].Content, "original") {
		t.Errorf("the Read ran after its sibling Write.\nRead returned:\n%s", results[0].Content)
	}
}

// Independent files must still run concurrently -- the ordering is scoped to a
// contended path, not a global lock on file tools.
func TestBatchedWritesToDifferentFilesBothLand(t *testing.T) {
	cwd := t.TempDir()
	a := filepath.Join(cwd, "a.txt")
	c := filepath.Join(cwd, "c.txt")

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "order-req-3",
		conv:      &conversation.Conversation{ID: "conv-order-3"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}},
	}

	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "Write", ID: "w1", Input: map[string]interface{}{"file_path": a, "content": "A\n"}},
		{Type: "tool_use", Name: "Write", ID: "w2", Input: map[string]interface{}{"file_path": c, "content": "C\n"}},
	}

	if _, err := b.executeTools(context.Background(), run, blocks, cwd); err != nil {
		t.Fatalf("executeTools: %v", err)
	}
	for path, want := range map[string]string{a: "A", c: "C"} {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(got), want) {
			t.Errorf("%s = %q, want %q", path, string(got), want)
		}
	}
}

// The round-5 finding, end to end: Write(f) batched with Grep over the
// directory holding f. The search walked while the write was in flight and
// missed a file that existed by the time the result was read.
func TestBatchedWriteAndDirectoryGrepFindsTheNewFile(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "fresh.txt")

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "order-req-grep",
		conv:      &conversation.Conversation{ID: "conv-order-grep"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}},
	}

	blocks := []types.LlmContentBlock{
		{
			Type: "tool_use",
			Name: "Write",
			ID:   "tc-write",
			Input: map[string]interface{}{
				"file_path": path,
				"content":   "diagnostics needle file\n",
			},
		},
		{
			Type: "tool_use",
			Name: "Grep",
			ID:   "tc-grep",
			Input: map[string]interface{}{
				"pattern":     "needle",
				"path":        cwd,
				"output_mode": "files_with_matches",
			},
		},
	}

	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatalf("executeTools: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("result count = %d, want 2", len(results))
	}

	// results[1] is the Grep. It must see the file its sibling Write created.
	if !strings.Contains(results[1].Content, "fresh.txt") {
		t.Errorf("the batched Grep missed its sibling Write's file.\nGrep returned:\n%s", results[1].Content)
	}
}
