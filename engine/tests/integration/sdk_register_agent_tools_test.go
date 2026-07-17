//go:build integration

package integration

// Integration test for the SDK's registerAgentTools() helper, verified
// through the ion-meta extension (its canonical user).
//
// Regression background: before the fix, the SDK's registerAgentTools()
// helper registered one dispatch tool per `agents/*.md` file, but the
// tool's execute() closure passed only `{ name, task }` to ctx.dispatchAgent
// — silently dropping the systemPrompt (the persona body below the
// frontmatter) and the per-agent model override. The dispatched specialist
// then ran as an unconfigured generic LLM and produced unrelated output,
// which the orchestrator surfaced to the user as a failed dispatch. See
// the "Fix ion-meta agent dispatches" plan for the full trace.
//
// What this test asserts:
//
//   1. ion-meta registers a `dispatch_<name>` tool for every specialist
//      `.md` file under `agents/` (parent != "" filter; orchestrator
//      excluded by default).
//   2. When one of those tools is invoked, the DispatchAgentOpts that
//      reach the engine carry BOTH a non-empty systemPrompt (the persona
//      body) AND the model string declared in the agent's frontmatter.
//      These are the load-bearing assertions — the fix is the persona
//      reaching the child session.
//
// We exercise the real extension subprocess (esbuild transpile + load),
// then intercept ctx.DispatchAgent on the engine side so we can inspect
// what the SDK helper actually sent over the `ext/dispatch_agent` wire.

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// TestSDKRegisterAgentTools_IonMetaWiresDispatchTools is the directory-walk
// half of the contract: every specialist .md file produces a registered
// dispatch tool. If the SDK helper drops files or mis-names them this test
// fails loudly.
func TestSDKRegisterAgentTools_IonMetaWiresDispatchTools(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load ion-meta: %v", err)
	}

	// Every specialist with a parent must have a dispatch_<name> tool.
	// The orchestrator (no parent) is excluded by the helper's default
	// filter, so it MUST NOT appear in the tool list.
	mustHave := []string{
		"dispatch_ion_tutor",
		"dispatch_extension_improver",
		"dispatch_extension_builder",
		"dispatch_extension_architect",
		"dispatch_agent_designer",
		"dispatch_skill_author",
		"dispatch_hook_specialist",
		"dispatch_testing_guide",
		"dispatch_orchestration_designer",
	}
	mustNotHave := []string{
		"dispatch_orchestrator", // root agent — filtered out by default
	}

	tools := host.Tools()
	have := make(map[string]struct{}, len(tools))
	for _, td := range tools {
		have[td.Name] = struct{}{}
	}
	for _, want := range mustHave {
		if _, ok := have[want]; !ok {
			t.Errorf("missing dispatch tool %q. registered: %v", want, toolNames(tools))
		}
	}
	for _, banned := range mustNotHave {
		if _, ok := have[banned]; ok {
			t.Errorf("orchestrator (no parent) should be filtered out, but %q was registered. "+
				"This means the default filter ((a) => !!a.parent) regressed in the SDK helper "+
				"or the orchestrator.md gained a `parent:` field by mistake.", banned)
		}
	}
}

// TestSDKRegisterAgentTools_DispatchCarriesPersonaAndModel is the load-
// bearing assertion of the fix. We invoke the registered tool for ion-tutor
// and assert the DispatchAgentOpts that arrive at ctx.DispatchAgent carry:
//
//   - opts.Name == "ion-tutor"
//   - opts.Task == the task we passed
//   - opts.SystemPrompt is non-empty (the persona body)
//   - opts.Model is non-empty (the model declared in the frontmatter)
//
// Before the fix, SystemPrompt and Model were both empty strings — the
// helper silently dropped them. If this test fails after a future SDK
// edit, the regression is the same one this fix repaired.
func TestSDKRegisterAgentTools_DispatchCarriesPersonaAndModel(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load ion-meta: %v", err)
	}

	// Find the dispatch_ion_tutor tool. The walk order is deterministic
	// per-platform (readdirSync) but the absolute order isn't part of
	// the contract, so we look up by name.
	var dispatchTutor *extension.ToolDefinition
	for i, td := range host.Tools() {
		if td.Name == "dispatch_ion_tutor" {
			dispatchTutor = &host.Tools()[i]
			break
		}
	}
	if dispatchTutor == nil {
		t.Fatalf("dispatch_ion_tutor tool not registered. registered: %v", toolNames(host.Tools()))
	}

	// Capture the DispatchAgentOpts the SDK helper sends over the
	// `ext/dispatch_agent` RPC. The host_rpc handler invokes
	// ctx.DispatchAgent with the deserialized opts — by wiring our own
	// closure we get the exact wire payload (post-JSON-roundtrip).
	var (
		captureMu     sync.Mutex
		capturedOpts  extension.DispatchAgentOpts
		dispatchFired = make(chan struct{}, 1)
	)
	ctx := &extension.Context{
		SessionKey: "sdk-register-agent-tools-test",
		Cwd:        "/tmp",
		// DispatchAgent is the seam: when the SDK helper's execute()
		// closure calls ctx.dispatchAgent({ name, task, systemPrompt,
		// model }), the JSON crosses the JSON-RPC stdio bridge and lands
		// here. We snapshot the opts and return a synthetic success result
		// so the calling tool's promise resolves.
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

	// Execute the dispatch tool. params is what the LLM would pass —
	// just the task; the agent name is captured on the SDK-side
	// closure (this is the whole point of registerAgentTools()).
	const taskText = "Explain how before_prompt fires."
	result, err := dispatchTutor.Execute(map[string]interface{}{
		"task": taskText,
	}, ctx)
	if err != nil {
		t.Fatalf("dispatchTutor.Execute: %v", err)
	}
	if result == nil {
		t.Fatal("dispatchTutor.Execute returned nil result")
	}
	if result.IsError {
		t.Errorf("expected non-error result, got IsError=true, content=%q", result.Content)
	}

	// Wait briefly for the dispatch to have fired — the SDK helper's
	// execute() is async, and the host_rpc handler runs DispatchAgent
	// in a goroutine. The Execute call above only returns after the
	// RPC response, so the goroutine has run by then; this select is
	// a defensive belt-and-suspenders against future refactors.
	select {
	case <-dispatchFired:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx.DispatchAgent was never called — the SDK helper's " +
			"execute() did not route through ext/dispatch_agent")
	}

	captureMu.Lock()
	defer captureMu.Unlock()

	if capturedOpts.Name != "ion-tutor" {
		t.Errorf("DispatchAgentOpts.Name: expected %q, got %q",
			"ion-tutor", capturedOpts.Name)
	}
	if capturedOpts.Task != taskText {
		t.Errorf("DispatchAgentOpts.Task: expected %q, got %q",
			taskText, capturedOpts.Task)
	}

	// The persona body for ion-tutor is thousands of characters — if it
	// arrives empty (or under a few hundred chars) the SDK helper has
	// regressed to the pre-fix behavior of dropping the body. We assert
	// a generous lower bound rather than an exact length so persona
	// edits don't break the test.
	if got := len(capturedOpts.SystemPrompt); got < 500 {
		t.Errorf("DispatchAgentOpts.SystemPrompt: expected the ion-tutor "+
			"persona body (~thousands of chars), got %d chars. "+
			"This means the SDK helper dropped the .md body — the exact "+
			"regression the fix repaired. content=%q",
			got, capturedOpts.SystemPrompt)
	}

	// Model must be the literal string from ion-tutor.md's frontmatter
	// (`model: standard`). The engine's ResolveTier maps tier names to
	// concrete model ids at runOpts assembly time; the SDK helper's job
	// is just to pass the literal through.
	if capturedOpts.Model != "standard" {
		t.Errorf("DispatchAgentOpts.Model: expected %q (from ion-tutor.md "+
			"frontmatter), got %q. If the frontmatter changed the test should "+
			"be updated; if it didn't, the SDK helper regressed.",
			"standard", capturedOpts.Model)
	}

	// Sanity: file paths in error messages should reference the live
	// extension directory so a regression is debuggable. (No assertion
	// — this is for human readers of failing test output.)
	_ = filepath.Join(metaDir, "agents", "ion-tutor.md")
}
