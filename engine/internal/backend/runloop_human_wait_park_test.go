package backend

// Tests for the human-wait client-tool PARK path (runloop_tools.go): calling
// a tool named in RunConfig.HumanWaitClientTools must terminate the run with
// a retained PermissionDenial carrying the full tool input — the
// AskUserQuestion sentinel treatment — and must NEVER route the call through
// the blocking McpToolRouter. This is what lets a structured question round
// survive stop, navigation, and engine restart: nothing is running while the
// user decides.

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteTools_HumanWaitClientToolParksRun pins the park: the run is
// flagged terminal (exitPlanMode), the denial carries the tool name/id/full
// input, a placeholder result lands, and the router is never invoked.
//
// Revert-check: with the HumanWaitClientTools interception removed, the call
// falls through to the router (routerCalls != 0) and no denial is recorded —
// both assertions go red.
func TestExecuteTools_HumanWaitClientToolParksRun(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	var routerCalls atomic.Int32
	router := func(_ context.Context, _ string, _ map[string]interface{}) (*types.ToolResult, error) {
		routerCalls.Add(1)
		return &types.ToolResult{Content: "should never run"}, nil
	}

	run := &activeRun{
		requestID: "test-hw-park",
		cfg: &RunConfig{
			McpToolRouter:        router,
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
		},
	}

	input := map[string]interface{}{
		"title": "Verification",
		"questions": []interface{}{
			map[string]interface{}{"id": "q1", "prompt": "Did it render?", "mode": "text"},
		},
	}
	blocks := []types.LlmContentBlock{{Type: "tool_use", Name: "AskUserQuestions", ID: "tu-1", Input: input}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}

	if routerCalls.Load() != 0 {
		t.Fatal("human-wait tool must park the run, never route through the blocking wire round-trip")
	}

	run.mu.Lock()
	parked := run.parkedHumanWait
	planExit := run.exitPlanMode
	denials := run.permissionDenials
	run.mu.Unlock()
	if !parked {
		t.Fatal("run must be flagged parkedHumanWait so the loop wraps up")
	}
	// The park must NOT borrow plan-mode's flag: doing so made the run report
	// "plan mode exited" and wrote "Plan mode exited." into the transcript of
	// every guided-questions round.
	if planExit {
		t.Error("park must not set exitPlanMode — it is not a plan-mode exit")
	}
	if len(denials) != 1 {
		t.Fatalf("want exactly 1 retained denial, got %d", len(denials))
	}
	d := denials[0]
	if d.ToolName != "AskUserQuestions" || d.ToolUseID != "tu-1" {
		t.Errorf("denial identity wrong: %+v", d)
	}
	// The FULL input must survive on the denial: it is what the client
	// re-renders after reconnect/restart.
	if d.ToolInput["title"] != "Verification" {
		t.Errorf("denial must retain the full tool input, got %+v", d.ToolInput)
	}
	if results[0].IsError || results[0].Content == "" {
		t.Errorf("placeholder tool result expected, got %+v", results[0])
	}
}

// TestExecuteTools_MachineClientToolStillRoutes pins the boundary: a client
// tool NOT named in HumanWaitClientTools keeps the blocking router path.
func TestExecuteTools_MachineClientToolStillRoutes(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	var routerCalls atomic.Int32
	router := func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		routerCalls.Add(1)
		return &types.ToolResult{Content: "machine result for " + name}, nil
	}

	run := &activeRun{
		requestID: "test-machine-routes",
		cfg: &RunConfig{
			McpToolRouter:        router,
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ExternalTools:        []types.LlmToolDef{{Name: "BenchMemberFile"}},
		},
	}

	blocks := []types.LlmContentBlock{{Type: "tool_use", Name: "BenchMemberFile", ID: "tu-2", Input: map[string]interface{}{}}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}
	if routerCalls.Load() != 1 {
		t.Fatalf("machine tool must route through the wire round-trip, calls=%d", routerCalls.Load())
	}
	run.mu.Lock()
	parked := run.parkedHumanWait
	run.mu.Unlock()
	if parked {
		t.Fatal("machine tool must not park the run")
	}
	if results[0].IsError {
		t.Errorf("machine result expected, got %+v", results[0])
	}
}

// TestExecuteTools_HumanWaitRefusesSiblingCalls pins the terminal-handoff
// contract: a human-wait tool ENDS the turn, so any sibling tool call in the
// same model response is refused BEFORE it executes.
//
// The defect this closes: tool calls run in parallel, so a model that paired
// AskUserQuestions with more work had those siblings race the park — real
// side effects landing after the run was terminal, results discarded, and the
// model reading its own turn as still in progress (so a requested
// continuation page was never re-issued while the operator's submitted
// answers waited for it).
//
// Revert-check: without the pre-scan, the sibling's executor runs and
// siblingRan flips true.
func TestExecuteTools_HumanWaitRefusesSiblingCalls(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	var siblingRan atomic.Bool
	router := func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		if name == "BenchMemberFile" {
			siblingRan.Store(true)
		}
		return &types.ToolResult{Content: "sibling result"}, nil
	}

	run := &activeRun{
		requestID: "test-hw-siblings",
		cfg: &RunConfig{
			McpToolRouter:        router,
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ExternalTools:        []types.LlmToolDef{{Name: "BenchMemberFile"}},
		},
	}

	// The model pairs the question with another tool call in ONE response.
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "AskUserQuestions", ID: "tu-q", Input: map[string]interface{}{
			"title":     "Round 2",
			"questions": []interface{}{map[string]interface{}{"id": "q1", "prompt": "Deeper?", "mode": "text"}},
		}},
		{Type: "tool_use", Name: "BenchMemberFile", ID: "tu-s", Input: map[string]interface{}{}},
	}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}

	if siblingRan.Load() {
		t.Fatal("sibling tool executed alongside a human-wait park: its side effects would land after the run is terminal")
	}

	run.mu.Lock()
	parked := run.parkedHumanWait
	denials := run.permissionDenials
	run.mu.Unlock()
	if !parked {
		t.Fatal("the run must still park when the question shares its turn")
	}
	if len(denials) != 1 || denials[0].ToolName != "AskUserQuestions" {
		t.Fatalf("the question must be retained exactly once, got %+v", denials)
	}

	// The sibling gets a non-error result explaining why, so the model can
	// re-issue it after the user answers rather than treating it as a failure.
	if results[1].IsError {
		t.Errorf("sibling refusal must not be a tool error, got %+v", results[1])
	}
	if !strings.Contains(results[1].Content, "Re-issue this call after the user answers") {
		t.Errorf("sibling refusal must say how to proceed, got %q", results[1].Content)
	}
}

func requiredStringSchema(field string) map[string]any {
	return map[string]any{
		"type":       "object",
		"required":   []any{field},
		"properties": map[string]any{field: map[string]any{"type": "string"}},
	}
}

func TestExecuteTools_InvalidMachineClientToolNeverRoutes(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	var routerCalls atomic.Int32
	run := &activeRun{
		requestID: "test-invalid-machine",
		cfg: &RunConfig{
			Telemetry: telem,
			ClientToolInputValidators: map[string]func(map[string]interface{}) error{
				"SearchCatalog": CompileClientToolInputValidator(requiredStringSchema("query")),
			},
			McpToolRouter: func(_ context.Context, _ string, _ map[string]interface{}) (*types.ToolResult, error) {
				routerCalls.Add(1)
				return &types.ToolResult{Content: "should never run"}, nil
			},
		},
	}
	blocks := []types.LlmContentBlock{{Name: "SearchCatalog", ID: "tu-invalid", Input: map[string]interface{}{"query": 42}}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if routerCalls.Load() != 0 {
		t.Fatal("invalid machine client tool input reached client routing")
	}
	if len(results) != 1 || !results[0].IsError || !strings.Contains(results[0].Content, "Invalid input") {
		t.Fatalf("invalid input must return a normal tool error, got %+v", results)
	}
	failures := telem.eventsByName("tool.failure")
	if !failureCategories(telem)["input_validation"] {
		t.Error("expected tool.failure telemetry with category input_validation")
	}
	if len(failures) != 1 {
		t.Fatalf("expected one tool.failure event, got %d", len(failures))
	}
	preview, _ := failures[0].Payload["error_preview"].(string)
	if len(preview) == 0 || len(preview) > clientToolValidationDiagnosticLimit {
		t.Fatalf("validation diagnostic must be present and bounded, length=%d", len(preview))
	}
}

func TestExecuteTools_InvalidHumanWaitDoesNotParkOrRefuseSibling(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	var siblingCalls atomic.Int32
	run := &activeRun{
		requestID: "test-invalid-human-wait",
		cfg: &RunConfig{
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ClientToolInputValidators: map[string]func(map[string]interface{}) error{
				"AskUserQuestions": CompileClientToolInputValidator(requiredStringSchema("title")),
				"BenchMemberFile":  CompileClientToolInputValidator(nil),
			},
			McpToolRouter: func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
				if name == "BenchMemberFile" {
					siblingCalls.Add(1)
				}
				return &types.ToolResult{Content: "sibling completed"}, nil
			},
		},
	}
	blocks := []types.LlmContentBlock{
		{Name: "AskUserQuestions", ID: "tu-invalid-question", Input: map[string]interface{}{"title": 42}},
		{Name: "BenchMemberFile", ID: "tu-sibling", Input: map[string]interface{}{}},
	}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if siblingCalls.Load() != 1 {
		t.Fatalf("valid sibling must remain active, calls=%d", siblingCalls.Load())
	}
	run.mu.Lock()
	parked := run.parkedHumanWait
	denials := len(run.permissionDenials)
	run.mu.Unlock()
	if parked || denials != 0 {
		t.Fatalf("invalid human-wait call must not park: parked=%v denials=%d", parked, denials)
	}
	if !results[0].IsError || results[1].IsError || results[1].Content != "sibling completed" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestExecuteTools_ValidHumanWaitDoesNotSuppressInvalidSiblingError(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "test-valid-human-invalid-sibling",
		cfg: &RunConfig{
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ClientToolInputValidators: map[string]func(map[string]interface{}) error{
				"AskUserQuestions": CompileClientToolInputValidator(requiredStringSchema("title")),
				"SearchCatalog":    CompileClientToolInputValidator(requiredStringSchema("query")),
			},
		},
	}
	blocks := []types.LlmContentBlock{
		{Name: "AskUserQuestions", ID: "tu-question", Input: map[string]interface{}{"title": "Choose"}},
		{Name: "SearchCatalog", ID: "tu-invalid-sibling", Input: map[string]interface{}{"query": 42}},
	}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError || !results[1].IsError || !strings.Contains(results[1].Content, "Invalid input") {
		t.Fatalf("valid wait must park while invalid sibling keeps validation error: %+v", results)
	}
}

func TestExecuteTools_ValidLargeHumanWaitStillParks(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	largeTitle := strings.Repeat("x", 256*1024)
	run := &activeRun{
		requestID: "test-large-human-wait",
		cfg: &RunConfig{
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ClientToolInputValidators: map[string]func(map[string]interface{}) error{
				"AskUserQuestions": CompileClientToolInputValidator(requiredStringSchema("title")),
			},
		},
	}
	blocks := []types.LlmContentBlock{{Name: "AskUserQuestions", ID: "tu-large", Input: map[string]interface{}{"title": largeTitle}}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run.mu.Lock()
	parked := run.parkedHumanWait
	denials := append([]types.PermissionDenial(nil), run.permissionDenials...)
	run.mu.Unlock()
	if !parked || len(denials) != 1 {
		t.Fatalf("valid large call must park unchanged: parked=%v denials=%d", parked, len(denials))
	}
	if denials[0].ToolInput["title"] != largeTitle || results[0].IsError {
		t.Fatal("valid large input was rejected or changed")
	}
}

// TestExecuteTools_HumanWaitAloneStillParks guards the boundary: the
// pre-scan must not change the ordinary single-call case.
func TestExecuteTools_HumanWaitAloneStillParks(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	run := &activeRun{
		requestID: "test-hw-alone",
		cfg: &RunConfig{
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
		},
	}
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "AskUserQuestions", ID: "tu-1", Input: map[string]interface{}{
			"title":     "Solo",
			"questions": []interface{}{map[string]interface{}{"id": "q1", "prompt": "One?", "mode": "text"}},
		}},
	}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatalf("executeTools error: %v", err)
	}
	run.mu.Lock()
	parked := run.parkedHumanWait
	run.mu.Unlock()
	if !parked {
		t.Fatal("a lone human-wait call must still park")
	}
}
