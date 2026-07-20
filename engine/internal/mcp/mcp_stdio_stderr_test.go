package mcp

import (
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// mcpLogMu serializes tests that install the process-global logger test sink.
var mcpLogMu sync.Mutex

// TestDrainStdioStderr_LogsServerStderr pins that drainStdioStderr forwards
// non-empty lines written by an MCP subprocess to stderr into the engine log
// with tag="mcp.stdio" and the correct serverName field. Without this
// goroutine, a subprocess crash reason or auth rejection is invisible in
// engine.jsonl. This test verifies the behavior without a real subprocess —
// a pipe writer goroutine drives drainStdioStderr to completion.
func TestDrainStdioStderr_LogsServerStderr(t *testing.T) {
	mcpLogMu.Lock()
	defer mcpLogMu.Unlock()

	var mu sync.Mutex
	type entry struct {
		tag    string
		fields map[string]any
	}
	var captured []entry

	prev := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag == "mcp.stdio" && msg == "server stderr" {
			mu.Lock()
			captured = append(captured, entry{tag: tag, fields: fields})
			mu.Unlock()
		}
	})
	defer func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prev)
	}()

	// Build a pipe: the writer goroutine plays the role of the MCP subprocess.
	pr, pw := io.Pipe()

	// Write one non-empty stderr line, then close to signal EOF so
	// drainStdioStderr exits its scan loop.
	go func() {
		_, _ = io.WriteString(pw, "error: cannot find module 'my-server'\n")
		pw.Close()
	}()

	// drainStdioStderr runs synchronously here (the pipe feeds one line then
	// closes, so the scanner exits immediately after processing that line).
	drainStdioStderr("test-mcp-server", pr)

	mu.Lock()
	defer mu.Unlock()

	if len(captured) == 0 {
		t.Fatal("expected at least one 'server stderr' log entry, got none")
	}
	got := captured[0]
	if got.tag != "mcp.stdio" {
		t.Errorf("expected tag=mcp.stdio, got %q", got.tag)
	}
	if serverName, _ := got.fields["serverName"].(string); serverName != "test-mcp-server" {
		t.Errorf("expected serverName=test-mcp-server, got %q", serverName)
	}
	if line, _ := got.fields["line"].(string); !strings.Contains(line, "cannot find module") {
		t.Errorf("expected line to contain error text, got %q", line)
	}
}

// TestDrainStdioStderr_SkipsBlankLines pins that blank and whitespace-only
// stderr lines do not produce log entries, keeping the engine log free of
// noise from subprocess line buffering.
func TestDrainStdioStderr_SkipsBlankLines(t *testing.T) {
	mcpLogMu.Lock()
	defer mcpLogMu.Unlock()

	var mu sync.Mutex
	var count int

	prev := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, _ map[string]any, _, _ string) {
		if tag == "mcp.stdio" && msg == "server stderr" {
			mu.Lock()
			count++
			mu.Unlock()
		}
	})
	defer func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prev)
	}()

	pr, pw := io.Pipe()
	go func() {
		_, _ = io.WriteString(pw, "\n\n   \n\n")
		pw.Close()
	}()

	drainStdioStderr("blank-server", pr)

	mu.Lock()
	defer mu.Unlock()
	if count != 0 {
		t.Errorf("expected no log entries for blank-only stderr, got %d", count)
	}
}
