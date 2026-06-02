package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestPersistAndPreview_UnderLimit(t *testing.T) {
	content := "short result"
	got, persisted := PersistAndPreview(content, "tool-1", "/tmp", "conv-1", 50000)
	if persisted {
		t.Fatal("expected persisted=false for short content")
	}
	if got != content {
		t.Fatalf("expected content unchanged, got %q", got)
	}
}

func TestPersistAndPreview_ExactlyAtLimit(t *testing.T) {
	content := strings.Repeat("x", 100)
	got, persisted := PersistAndPreview(content, "tool-2", "/tmp", "conv-2", 100)
	if persisted {
		t.Fatal("expected persisted=false for content at exactly the limit")
	}
	if got != content {
		t.Fatalf("expected content unchanged, got len=%d", len(got))
	}
}

func TestPersistAndPreview_OverLimit(t *testing.T) {
	tmpDir := t.TempDir()
	content := strings.Repeat("A", 10000)
	maxChars := 500

	got, persisted := PersistAndPreview(content, "tool-3", tmpDir, "conv-3", maxChars)
	if !persisted {
		t.Fatal("expected persisted=true for oversized content")
	}

	// The preview should start with the first previewChars characters
	if !strings.HasPrefix(got, content[:previewChars]) {
		t.Fatal("preview should start with the first previewChars of content")
	}

	// Should mention the file path
	expectedPath := filepath.Join(tmpDir, "tool-results", "conv-3", "tool-3.txt")
	if !strings.Contains(got, expectedPath) {
		t.Fatalf("preview should contain file path %q, got %q", expectedPath, got)
	}

	// Should mention truncation metadata
	if !strings.Contains(got, "10000 total characters") {
		t.Fatal("preview should mention total character count")
	}
	if !strings.Contains(got, "showing first 2000") {
		t.Fatal("preview should mention preview length")
	}

	// Verify file was written with full content
	data, err := os.ReadFile(expectedPath)
	if err != nil {
		t.Fatalf("failed to read persisted file: %v", err)
	}
	if string(data) != content {
		t.Fatalf("persisted file content mismatch: len=%d expected=%d", len(data), len(content))
	}
}

func TestPersistAndPreview_ShortContentOverLimit(t *testing.T) {
	// Content is over the limit but under previewChars — preview = full content prefix.
	tmpDir := t.TempDir()
	content := strings.Repeat("B", 1500)
	maxChars := 100

	got, persisted := PersistAndPreview(content, "tool-4", tmpDir, "conv-4", maxChars)
	if !persisted {
		t.Fatal("expected persisted=true")
	}

	// Since content (1500) < previewChars (2000), the preview should be the full content
	if !strings.HasPrefix(got, content) {
		t.Fatal("when content < previewChars, preview should start with full content")
	}
}

func TestPersistAndPreview_DefaultLimit(t *testing.T) {
	// maxChars=0 should use DefaultMaxToolResultChars
	content := strings.Repeat("C", DefaultMaxToolResultChars)
	got, persisted := PersistAndPreview(content, "tool-5", "/tmp", "conv-5", 0)
	if persisted {
		t.Fatal("expected persisted=false for content at default limit")
	}
	if got != content {
		t.Fatal("content should be unchanged at default limit boundary")
	}
}

func TestPersistAndPreview_DefaultLimitExceeded(t *testing.T) {
	tmpDir := t.TempDir()
	content := strings.Repeat("D", DefaultMaxToolResultChars+1)
	got, persisted := PersistAndPreview(content, "tool-6", tmpDir, "conv-6", 0)
	if !persisted {
		t.Fatal("expected persisted=true for content exceeding default limit")
	}
	if !strings.Contains(got, "Tool result truncated") {
		t.Fatal("preview should contain truncation notice")
	}
}

func TestAddToolResultsWithSizeCheck_MixedSizes(t *testing.T) {
	tmpDir := t.TempDir()
	conv := &Conversation{ID: "test-conv"}
	results := []ToolResultEntry{
		{ToolUseID: "small-1", Content: "small result"},
		{ToolUseID: "big-1", Content: strings.Repeat("X", 5000)},
		{ToolUseID: "small-2", Content: "another small result"},
	}

	AddToolResultsWithSizeCheck(conv, results, tmpDir, 500)

	// Should have 1 user message with 3 tool_result blocks
	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(conv.Messages))
	}
	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected Content to be []LlmContentBlock")
	}
	if len(blocks) != 3 {
		t.Fatalf("expected 3 blocks, got %d", len(blocks))
	}

	// First and third should be unchanged
	if blocks[0].Content != "small result" {
		t.Fatal("first block should be unchanged")
	}
	if blocks[2].Content != "another small result" {
		t.Fatal("third block should be unchanged")
	}

	// Second should be truncated
	if !strings.Contains(blocks[1].Content, "Tool result truncated") {
		t.Fatal("second block should be truncated")
	}

	// Verify file was written
	expectedPath := filepath.Join(tmpDir, "tool-results", "test-conv", "big-1.txt")
	if _, err := os.Stat(expectedPath); os.IsNotExist(err) {
		t.Fatalf("expected persisted file at %s", expectedPath)
	}
}
