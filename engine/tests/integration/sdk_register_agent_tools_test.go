//go:build integration

package integration

// Integration test for the SDK's registerAgentTools() helper, verified
// through a self-contained fixture extension built in a temp dir.
//
// Regression background: before the fix, the SDK's registerAgentTools()
// helper registered one dispatch tool per `agents/*.md` file, but the
// tool's execute() closure passed only `{ name, task }` to ctx.dispatchAgent
// — silently dropping the systemPrompt (the persona body below the
// frontmatter) and the per-agent model override. The dispatched specialist
// then ran as an unconfigured generic LLM and produced unrelated output,
// which the orchestrator surfaced to the user as a failed dispatch.
//
// What this test asserts:
//
//  1. The helper registers a `dispatch_<name>` tool for every specialist
//     `.md` file under `agents/` with a parent, and excludes root agents
//     (no parent) via the default filter.
//  2. When one of those tools is invoked, the DispatchAgentOpts that
//     reach the engine carry BOTH a non-empty systemPrompt (the persona
//     body) AND the model string declared in the agent's frontmatter.
//     These are the load-bearing assertions — the fix is the persona
//     reaching the child session.
//
// We exercise the real extension subprocess (esbuild transpile + load),
// then intercept ctx.DispatchAgent on the engine side so we can inspect
// what the SDK helper actually sent over the `ext/dispatch_agent` wire.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// writeAgentToolsFixture builds a minimal extension in a temp dir: an index.ts
// that calls registerAgentTools(), plus an agents/ directory with one root
// agent (must be filtered out) and one specialist (must be wired). The SDK is
// imported from the repo source, which is what the subprocess host resolves.
func writeAgentToolsFixture(t *testing.T) (extDir, entry string) {
	t.Helper()
	extDir = t.TempDir()

	sdkPath, err := filepath.Abs(filepath.Join("..", "..", "extensions", "sdk", "ion-sdk"))
	if err != nil {
		t.Fatalf("resolve sdk path: %v", err)
	}
	indexTs := "import { createIon } from '" + sdkPath + "'\n" +
		"const ion = createIon()\n" +
		"ion.registerAgentTools()\n"
	entry = filepath.Join(extDir, "index.ts")
	if err := os.WriteFile(entry, []byte(indexTs), 0o644); err != nil {
		t.Fatalf("write index.ts: %v", err)
	}

	agentsDir := filepath.Join(extDir, "agents")
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		t.Fatalf("mkdir agents: %v", err)
	}

	// Root agent: no parent — the default filter must exclude it.
	root := `---
name: coordinator
description: routes work
---
Root persona body. Not a dispatch target.
`
	if err := os.WriteFile(filepath.Join(agentsDir, "coordinator.md"), []byte(root), 0o644); err != nil {
		t.Fatalf("write coordinator.md: %v", err)
	}

	// Specialist: parent + model + a persona body long enough that a helper
	// dropping it is unambiguous.
	persona := strings.Repeat("The specialist persona explains one subsystem in depth. ", 20)
	specialist := `---
name: doc-writer
parent: coordinator
description: documentation writing
model: standard
---
` + persona + "\n"
	if err := os.WriteFile(filepath.Join(agentsDir, "doc-writer.md"), []byte(specialist), 0o644); err != nil {
		t.Fatalf("write doc-writer.md: %v", err)
	}
	return extDir, entry
}

// TestSDKRegisterAgentTools_WiresDispatchTools is the directory-walk half of
// the contract: every specialist .md file produces a registered dispatch
// tool, and root agents are filtered out.
func TestSDKRegisterAgentTools_WiresDispatchTools(t *testing.T) {
	requireEsbuild(t)
	extDir, entry := writeAgentToolsFixture(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load fixture extension: %v", err)
	}

	tools := host.Tools()
	have := make(map[string]struct{}, len(tools))
	for _, td := range tools {
		have[td.Name] = struct{}{}
	}
	if _, ok := have["dispatch_doc_writer"]; !ok {
		t.Errorf("missing dispatch tool for the specialist. registered: %v", toolNames(tools))
	}
	if _, ok := have["dispatch_coordinator"]; ok {
		t.Errorf("root agent (no parent) should be filtered out, but dispatch_coordinator was registered. "+
			"This means the default filter ((a) => !!a.parent) regressed in the SDK helper. registered: %v", toolNames(tools))
	}
}

// TestSDKRegisterAgentTools_DispatchCarriesPersonaAndModel is the load-
// bearing assertion of the fix: the DispatchAgentOpts that arrive at
// ctx.DispatchAgent carry the persona body and the frontmatter model, not
// just the name and task.
func TestSDKRegisterAgentTools_DispatchCarriesPersonaAndModel(t *testing.T) {
	requireEsbuild(t)
	extDir, entry := writeAgentToolsFixture(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load fixture extension: %v", err)
	}

	var dispatchTool *extension.ToolDefinition
	for i, td := range host.Tools() {
		if td.Name == "dispatch_doc_writer" {
			dispatchTool = &host.Tools()[i]
			break
		}
	}
	if dispatchTool == nil {
		t.Fatalf("dispatch_doc_writer tool not registered. registered: %v", toolNames(host.Tools()))
	}

	// Capture the DispatchAgentOpts the SDK helper sends over the
	// `ext/dispatch_agent` RPC. The host_rpc handler invokes
	// ctx.DispatchAgent with the deserialized opts — wiring our own closure
	// yields the exact wire payload (post-JSON-roundtrip).
	var (
		captureMu     sync.Mutex
		capturedOpts  extension.DispatchAgentOpts
		dispatchFired = make(chan struct{}, 1)
	)
	ctx := &extension.Context{
		SessionKey: "sdk-register-agent-tools-test",
		Cwd:        "/tmp",
		DispatchAgent: func(opts extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
			captureMu.Lock()
			capturedOpts = opts
			captureMu.Unlock()
			select {
			case dispatchFired <- struct{}{}:
			default:
			}
			return &extension.DispatchAgentResult{
				Output:   "test stub: dispatch reached",
				ExitCode: 0,
			}, nil
		},
	}

	const taskText = "Document how before_prompt fires."
	result, err := dispatchTool.Execute(map[string]interface{}{
		"task": taskText,
	}, ctx)
	if err != nil {
		t.Fatalf("dispatchTool.Execute: %v", err)
	}
	if result == nil {
		t.Fatal("dispatchTool.Execute returned nil result")
	}
	if result.IsError {
		t.Errorf("expected non-error result, got IsError=true, content=%q", result.Content)
	}

	select {
	case <-dispatchFired:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx.DispatchAgent was never called — the SDK helper's " +
			"execute() did not route through ext/dispatch_agent")
	}

	captureMu.Lock()
	defer captureMu.Unlock()

	if capturedOpts.Name != "doc-writer" {
		t.Errorf("DispatchAgentOpts.Name: expected %q, got %q", "doc-writer", capturedOpts.Name)
	}
	if capturedOpts.Task != taskText {
		t.Errorf("DispatchAgentOpts.Task: expected %q, got %q", taskText, capturedOpts.Task)
	}

	// The fixture persona is ~1100 chars — if it arrives empty (or tiny) the
	// SDK helper has regressed to the pre-fix behavior of dropping the body.
	if got := len(capturedOpts.SystemPrompt); got < 500 {
		t.Errorf("DispatchAgentOpts.SystemPrompt: expected the persona body "+
			"(~1100 chars), got %d chars. The SDK helper dropped the .md body — "+
			"the exact regression the fix repaired. content=%q",
			got, capturedOpts.SystemPrompt)
	}

	// Model must be the literal frontmatter string; the engine's ResolveTier
	// maps tier names to concrete model ids later. The helper's job is only
	// to pass the literal through.
	if capturedOpts.Model != "standard" {
		t.Errorf("DispatchAgentOpts.Model: expected %q (from the fixture "+
			"frontmatter), got %q — the SDK helper dropped the model.",
			"standard", capturedOpts.Model)
	}
}
