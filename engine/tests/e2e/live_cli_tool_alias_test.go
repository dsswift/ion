//go:build e2e

package e2e

// TestLiveCliToolAlias is the end-to-end behavioral smoke for the tool-alias
// directive added in commit a9671718.
//
// The unit tests in internal/session prove the directive is appended to
// AppendSystemPrompt correctly.  This test proves the directive actually works:
// the CLI subprocess receives a prompt that references a bare tool name, the
// alias directive maps it to the MCP-prefixed form, and the model calls it.
//
// What this covers that unit tests cannot:
//   - The Claude CLI subprocess picks up the MCP config and loads the ToolServer.
//   - The model reads the alias directive and translates "echo_marker" →
//     "mcp__ion-extensions__echo_marker" before issuing the tool call.
//   - The ToolServer receives and dispatches the call, returning the sentinel.
//   - The engine normalises the tool call + result events and surfaces them.
//
// Skip conditions (clean skip, no failure):
//   - Claude binary not found on the system.
//   - testconfig.json absent or Anthropic API key not configured (the CLI
//     backend uses OAuth, not the API key, but the config file signals the
//     environment is set up for e2e).

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// skipIfNoClaudeBinary skips the test when the Claude CLI binary is not
// reachable.  The search order mirrors findClaudeBinary in cli_backend.go so
// this gate and the real runtime agree.
func skipIfNoClaudeBinary(t *testing.T) {
	t.Helper()
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
		filepath.Join(home, ".npm-global", "bin", "claude"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return // found
		}
	}
	t.Skip("claude binary not found — skipping CLI tool-alias e2e smoke")
}

// TestLiveCliToolAlias runs an extension tool with a BARE name through the
// full CLI backend path and asserts the model called it via the alias
// directive.
func TestLiveCliToolAlias(t *testing.T) {
	skipIfNoClaudeBinary(t)

	// The CLI backend uses OAuth (not an API key), but we check testconfig
	// presence as a proxy for "this environment is wired for e2e".
	_, cfgErr := loadTestConfig()
	if cfgErr != nil {
		t.Skipf("testconfig.json not found (%v) — skipping CLI tool-alias e2e smoke", cfgErr)
	}

	// ── Sentinel setup ────────────────────────────────────────────────────
	// A unique string the tool returns.  If the model calls it, the sentinel
	// appears in a ToolResultEvent.  This value is chosen to be unlikely to
	// appear in any model-generated text.
	const sentinel = "ECHO_MARKER_SENTINEL_99f3a2b1"

	var toolInvoked atomic.Bool
	var toolResultSeen atomic.Bool

	// ── Extension group ───────────────────────────────────────────────────
	host := extension.NewHost()
	host.SDK().RegisterTool(extension.ToolDefinition{
		Name:        "echo_marker",
		Description: "Returns a fixed sentinel string to confirm it was invoked.",
		Parameters: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			toolInvoked.Store(true)
			return &types.ToolResult{Content: sentinel}, nil
		},
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	// ── Manager + session ─────────────────────────────────────────────────
	cb := backend.NewClaudeCodeBackend()
	mgr := session.NewManager(cb)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-cli-alias",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("e2e-ca", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("e2e-ca") })

	// Wire the extension group before SendPrompt so wireToolServer sees it.
	mgr.TestSetExtGroup("e2e-ca", group)

	// ── Event collection ──────────────────────────────────────────────────
	var (
		eventMu         sync.Mutex
		toolCallNames   []string
		toolResultConts []string
		engineErrors    []types.EngineEvent
	)
	done := make(chan struct{})
	var doneOnce sync.Once

	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		eventMu.Lock()
		defer eventMu.Unlock()

		switch ev.Type {
		case "engine_tool_call":
			toolCallNames = append(toolCallNames, ev.ToolName)
		case "engine_tool_result":
			toolResultConts = append(toolResultConts, ev.ToolResult)
			if strings.Contains(ev.ToolResult, sentinel) {
				toolResultSeen.Store(true)
			}
		case "engine_error":
			engineErrors = append(engineErrors, ev)
		case "engine_status":
			if ev.Fields != nil && ev.Fields.State == "idle" && ev.Fields.SessionID != "" {
				doneOnce.Do(func() { close(done) })
			}
		}
	})

	// Also watch NormalizedEvents on the CliBackend directly, because the CLI
	// backend's ToolCallEvent carries the prefixed name as seen by the
	// subprocess and ToolResultEvent carries the content returned by the
	// ToolServer.  Both paths are exercised here.
	var (
		normalMu          sync.Mutex
		normalToolCalls   []string
		normalToolResults []string
	)
	cb.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		normalMu.Lock()
		defer normalMu.Unlock()
		switch d := ev.Data.(type) {
		case *types.ToolCallEvent:
			normalToolCalls = append(normalToolCalls, d.ToolName)
		case *types.ToolResultEvent:
			normalToolResults = append(normalToolResults, d.Content)
			if strings.Contains(d.Content, sentinel) {
				toolResultSeen.Store(true)
			}
		}
	})

	// ── Prompt ────────────────────────────────────────────────────────────
	// Reference the tool only by its BARE name.  The alias directive
	// (appended by wireToolServer) tells the model the bare name maps to
	// mcp__ion-extensions__echo_marker.  Without the directive the model
	// would either fail to call the tool or error attempting the bare name.
	prompt := `Call the echo_marker tool now with no arguments. ` +
		`Do not explain, just call it immediately and report what it returns.`

	if err := mgr.SendPrompt("e2e-ca", prompt, nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	// ── Wait for completion ───────────────────────────────────────────────
	select {
	case <-done:
	case <-time.After(120 * time.Second):
		t.Fatal("timed out waiting for CLI run to complete (120s)")
	}

	// ── Assertions ────────────────────────────────────────────────────────
	eventMu.Lock()
	errs := make([]types.EngineEvent, len(engineErrors))
	copy(errs, engineErrors)
	calls := make([]string, len(toolCallNames))
	copy(calls, toolCallNames)
	eventMu.Unlock()

	normalMu.Lock()
	ncalls := make([]string, len(normalToolCalls))
	copy(ncalls, normalToolCalls)
	nresults := make([]string, len(normalToolResults))
	copy(nresults, normalToolResults)
	normalMu.Unlock()

	// Log state for diagnostics regardless of pass/fail.
	t.Logf("engine tool call events: %v", calls)
	t.Logf("normalizer tool call events: %v", ncalls)
	t.Logf("normalizer tool result contents: %v", nresults)
	t.Logf("toolInvoked=%v toolResultSeen=%v", toolInvoked.Load(), toolResultSeen.Load())

	// Hard-fail on engine_error (surfaced by the CLI backend).
	for _, e := range errs {
		t.Errorf("engine_error: %s (code: %s)", e.EventMessage, e.ErrorCode)
	}

	// The ToolServer must have been called.  toolInvoked is set inside the
	// Execute closure, which runs synchronously in the ToolServer goroutine
	// when the CLI subprocess issues the MCP call.
	if !toolInvoked.Load() {
		// Collect all tool call names seen for the failure message.
		allCalls := append(ncalls, calls...) //nolint:gocritic
		t.Errorf("echo_marker was never invoked by the model.\n"+
			"This means the alias directive did not bridge the bare tool name.\n"+
			"Tool calls observed: %v\n"+
			"Expected at least one call to mcp__%s__echo_marker.",
			allCalls, backend.McpServerName)
	}

	// The sentinel must have come back through the event stream.
	if !toolResultSeen.Load() {
		t.Errorf("sentinel %q not seen in any tool result event.\n"+
			"Tool results observed: %v",
			sentinel, nresults)
	}

	// The prefixed tool name must appear in the normalizer tool-call stream
	// (proving the CLI subprocess actually issued the MCP call and did not
	// just hallucinate the output).
	prefixed := "mcp__" + backend.McpServerName + "__echo_marker"
	foundPrefixed := false
	for _, name := range ncalls {
		if name == prefixed {
			foundPrefixed = true
			break
		}
	}
	if !foundPrefixed {
		t.Errorf("prefixed tool name %q not seen in normalizer ToolCallEvents.\n"+
			"Calls observed: %v\n"+
			"This suggests the model called a different name or did not call the tool.",
			prefixed, ncalls)
	}
}
