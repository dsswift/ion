//go:build integration

package integration

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// ─── Backend Loop: Multi-turn ───

func TestApiBackendMultiTurn(t *testing.T) {
	mp := setupMockProvider(t)

	// Turn 1: tool call (Read)
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "multi-turn.txt")
	os.WriteFile(testFile, []byte("multi-turn content"), 0644)

	mp.SetResponse(helpers.ToolCallResponse("Read", "tool_mt_1", map[string]interface{}{
		"file_path": testFile,
	}))
	// Turn 2: text response
	mp.SetResponse(helpers.TextResponse("I read the file and it contains multi-turn content."))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-multi-turn", types.RunOptions{
		Prompt:      "Read the file then summarize",
		Model:       "mock-model",
		ProjectPath: tmpDir,
	})

	be.waitForExit(t, 5*time.Second)

	events := be.getNormalized()

	// Should have tool_call, tool_result, text_chunk, task_complete.
	var foundToolCall, foundToolResult, foundText, foundComplete bool
	for _, ev := range events {
		switch e := ev.Data.(type) {
		case *types.ToolCallEvent:
			if e.ToolName == "Read" {
				foundToolCall = true
			}
		case *types.ToolResultEvent:
			foundToolResult = true
		case *types.TextChunkEvent:
			if strings.Contains(e.Text, "multi-turn") {
				foundText = true
			}
		case *types.TaskCompleteEvent:
			foundComplete = true
		}
	}

	if !foundToolCall {
		t.Error("missing tool_call event")
	}
	if !foundToolResult {
		t.Error("missing tool_result event")
	}
	if !foundText {
		t.Error("missing text_chunk with multi-turn content")
	}
	if !foundComplete {
		t.Error("missing task_complete event")
	}
}

// ─── Backend Loop: Simple Text Response ───

func TestApiBackendSimpleText(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("Simple response text"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-simple-text", types.RunOptions{
		Prompt: "Say something",
		Model:  "mock-model",
	})

	be.waitForExit(t, 5*time.Second)

	events := be.getNormalized()

	foundText := false
	foundComplete := false
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok && tc.Text == "Simple response text" {
			foundText = true
		}
		if _, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			foundComplete = true
		}
	}

	if !foundText {
		t.Error("missing expected text_chunk")
	}
	if !foundComplete {
		t.Error("missing task_complete")
	}
}

// ─── Backend: Unknown tool returns error result ───

func TestApiBackendUnknownTool(t *testing.T) {
	mp := setupMockProvider(t)

	mp.SetResponse(helpers.ToolCallResponse("NonExistentTool", "tool_bad_1", map[string]interface{}{
		"foo": "bar",
	}))
	mp.SetResponse(helpers.TextResponse("Recovered from error"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-bad-tool", types.RunOptions{
		Prompt: "Call unknown tool",
		Model:  "mock-model",
	})

	be.waitForExit(t, 5*time.Second)

	events := be.getNormalized()

	foundErrorResult := false
	for _, ev := range events {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok && tr.IsError {
			if strings.Contains(tr.Content, "Unknown tool") || strings.Contains(tr.Content, "not found") {
				foundErrorResult = true
			}
		}
	}

	if !foundErrorResult {
		t.Error("expected error tool_result for unknown tool")
	}
}

// ─── Backend: Cancel returns false for unknown run ───

func TestApiBackendCancelUnknown(t *testing.T) {
	b := backend.NewApiBackend()
	if b.Cancel("nonexistent-run-id") {
		t.Error("expected Cancel to return false for unknown run ID")
	}
}

// ─── Backend: IsRunning ───

func TestApiBackendIsRunning(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("done"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	if b.IsRunning("run-check") {
		t.Error("expected IsRunning=false before start")
	}

	b.StartRun("run-check", types.RunOptions{
		Prompt: "Check running",
		Model:  "mock-model",
	})

	be.waitForExit(t, 5*time.Second)

	if b.IsRunning("run-check") {
		t.Error("expected IsRunning=false after completion")
	}
}

// ─── Provider Contract: Message formatting ───

func TestProviderReceivesFormattedMessages(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("Got it"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-msg-fmt", types.RunOptions{
		Prompt: "Format test prompt",
		Model:  "mock-model",
	})

	be.waitForExit(t, 5*time.Second)

	calls := mp.Calls()
	if len(calls) == 0 {
		t.Fatal("expected at least one provider call")
	}

	firstCall := calls[0]
	if firstCall.Model != "mock-model" {
		t.Errorf("expected model=mock-model, got %q", firstCall.Model)
	}
	if len(firstCall.Messages) == 0 {
		t.Error("expected at least one message in provider call")
	}

	// First message should be the user prompt.
	userMsg := firstCall.Messages[0]
	if userMsg.Role != "user" {
		t.Errorf("expected first message role=user, got %q", userMsg.Role)
	}
}

// ─── Provider Contract: Error handling ───

func TestProviderErrorResultsInErrorEvent(t *testing.T) {
	mp := setupMockProvider(t)

	mp.SetResponseWithError(nil, &providers.ProviderError{
		Code:    "rate_limit",
		Message: "rate limited",
	})

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-provider-err", types.RunOptions{
		Prompt: "Trigger error",
		Model:  "mock-model",
	})

	be.waitForExit(t, 5*time.Second)

	be.mu.Lock()
	errCount := len(be.errors)
	be.mu.Unlock()

	if errCount == 0 {
		t.Error("expected error event from provider failure")
	}
}

// ─── Backend: Write tool creates file ───

func TestApiBackendWriteTool(t *testing.T) {
	mp := setupMockProvider(t)

	tmpDir := t.TempDir()
	outFile := filepath.Join(tmpDir, "written.txt")

	mp.SetResponse(helpers.ToolCallResponse("Write", "tool_write_1", map[string]interface{}{
		"file_path": outFile,
		"content":   "Hello from test",
	}))
	mp.SetResponse(helpers.TextResponse("File written."))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-write-tool", types.RunOptions{
		Prompt:      "Write a file",
		Model:       "mock-model",
		ProjectPath: tmpDir,
	})

	be.waitForExit(t, 5*time.Second)

	data, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "Hello from test" {
		t.Errorf("file content: got %q, want %q", string(data), "Hello from test")
	}
}
