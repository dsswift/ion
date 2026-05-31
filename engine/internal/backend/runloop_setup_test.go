package backend

import (
	"os"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// --- buildSystemPrompt tests ---

func TestBuildSystemPrompt_ResumeWithoutDuplication(t *testing.T) {
	// Simulate resume: conv.System already has CLAUDE.md from first run,
	// AppendSystemPrompt delivers CLAUDE.md again. Must appear once.
	claudeContent := "# Context from /home/user/.claude/CLAUDE.md\nBe helpful."
	conv := &conversation.Conversation{
		System: "\n\n" + claudeContent, // left over from first run
	}
	opts := &types.RunOptions{
		AppendSystemPrompt: claudeContent,
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-1", nil)
	count := strings.Count(result, claudeContent)
	if count != 1 {
		t.Errorf("expected CLAUDE.md to appear once, appeared %d times", count)
	}
}

func TestBuildSystemPrompt_SystemPromptOverride(t *testing.T) {
	conv := &conversation.Conversation{
		System: "old system prompt",
	}
	opts := &types.RunOptions{
		SystemPrompt: "new system prompt",
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-2", nil)
	if result != "new system prompt" {
		t.Errorf("expected SystemPrompt override, got %q", result)
	}
}

func TestBuildSystemPrompt_PreservedWhenNoAppend(t *testing.T) {
	conv := &conversation.Conversation{
		System: "preserved system",
	}
	opts := &types.RunOptions{} // no SystemPrompt, no AppendSystemPrompt
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-3", nil)
	if result != "preserved system" {
		t.Errorf("expected conv.System to be preserved, got %q", result)
	}
}

func TestBuildSystemPrompt_FirstPromptClean(t *testing.T) {
	conv := &conversation.Conversation{} // System is ""
	claudeContent := "# CLAUDE.md content"
	opts := &types.RunOptions{
		AppendSystemPrompt: claudeContent,
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-4", nil)
	count := strings.Count(result, claudeContent)
	if count != 1 {
		t.Errorf("expected content once, appeared %d times", count)
	}
	// Should start with "\n\n" since base is ""
	if !strings.HasPrefix(result, "\n\n") {
		t.Errorf("expected leading newlines from empty base, got %q", result[:10])
	}
}

func TestBuildSystemPrompt_PlanModeWithAppend(t *testing.T) {
	// Plan mode adds its own suffix; AppendSystemPrompt must still not dup
	conv := &conversation.Conversation{
		System: "\n\ncontext content\n\nplan mode prompt",
	}
	opts := &types.RunOptions{
		AppendSystemPrompt: "context content",
		PlanMode:           true,
		PlanFilePath:       "/tmp/nonexistent-plan.md",
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-5", nil)
	count := strings.Count(result, "context content")
	if count != 1 {
		t.Errorf("expected 'context content' once in plan mode, appeared %d times", count)
	}
}

func TestBuildSystemPrompt_ExplicitBaseWithAppend(t *testing.T) {
	// When both SystemPrompt and AppendSystemPrompt are set, use SystemPrompt as base
	conv := &conversation.Conversation{
		System: "stale conv system",
	}
	opts := &types.RunOptions{
		SystemPrompt:       "fresh base",
		AppendSystemPrompt: "appended context",
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-6", nil)
	if !strings.HasPrefix(result, "fresh base\n\nappended context") {
		t.Errorf("expected fresh base + append, got %q", result)
	}
	if strings.Contains(result, "stale conv system") {
		t.Error("stale conv.System should not appear")
	}
}

// --- web search mode resolution tests ---

func TestWebSearchMode_AutoAnthropicNoClientKey(t *testing.T) {
	// Unset all client search keys
	for _, k := range []string{"BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "SEARXNG_URL"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}

	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "auto"}
	provider := &mockLlmProvider{id: "anthropic"}

	_, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) == 0 {
		t.Error("expected server tools for auto + anthropic + no client key")
	}
}

func TestWebSearchMode_AutoAnthropicWithClientKey(t *testing.T) {
	t.Setenv("BRAVE_SEARCH_API_KEY", "test-key-123")

	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "auto"}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) != 0 {
		t.Error("expected no server tools when client key is available")
	}
	// Verify WebSearch tool is still present
	hasWebSearch := false
	for _, td := range toolDefs {
		if td.Name == "WebSearch" {
			hasWebSearch = true
			break
		}
	}
	if !hasWebSearch {
		t.Error("expected WebSearch client tool to remain")
	}
}

func TestWebSearchMode_AutoOpenAI(t *testing.T) {
	// Unset all client search keys
	for _, k := range []string{"BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "SEARXNG_URL"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}

	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "auto"}
	provider := &mockLlmProvider{id: "openai"}

	_, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) != 0 {
		t.Error("expected no server tools for OpenAI provider")
	}
}

func TestWebSearchMode_ServerAnthropic(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "server"}
	provider := &mockLlmProvider{id: "anthropic"}

	_, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) == 0 {
		t.Error("expected server tools for explicit server + anthropic")
	}
}

func TestWebSearchMode_ServerOpenAI(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "server"}
	provider := &mockLlmProvider{id: "openai"}

	_, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) != 0 {
		t.Error("expected no server tools for server + openai (silent fallback)")
	}
}

func TestWebSearchMode_ClientAnthropic(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "client"}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) != 0 {
		t.Error("expected no server tools for explicit client mode")
	}
	hasWebSearch := false
	for _, td := range toolDefs {
		if td.Name == "WebSearch" {
			hasWebSearch = true
			break
		}
	}
	if !hasWebSearch {
		t.Error("expected WebSearch client tool to remain in client mode")
	}
}

func TestWebSearchMode_ClientOpenAI(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{WebSearchMode: "client"}
	provider := &mockLlmProvider{id: "openai"}

	toolDefs, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) != 0 {
		t.Error("expected no server tools for client + openai")
	}
	hasWebSearch := false
	for _, td := range toolDefs {
		if td.Name == "WebSearch" {
			hasWebSearch = true
			break
		}
	}
	if !hasWebSearch {
		t.Error("expected WebSearch client tool to remain")
	}
}

func TestWebSearchMode_DefaultsToAuto(t *testing.T) {
	// Unset all client search keys to trigger server-side for Anthropic
	for _, k := range []string{"BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "SEARXNG_URL"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}

	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{} // WebSearchMode is ""
	provider := &mockLlmProvider{id: "anthropic"}

	_, serverTools := b.buildToolDefs(run, opts, provider)
	if len(serverTools) == 0 {
		t.Error("expected server tools for default (empty) mode + anthropic + no client key")
	}
}

// --- plan mode prompt tests ---

func TestBuildPlanModePrompt_ExistingFile(t *testing.T) {
	prompt := buildPlanModePrompt("/tmp/plan.md", true)

	checks := []struct {
		label    string
		contains string
	}{
		{"read first", "MUST Read it first"},
		{"edit tool", "Edit tool"},
		{"no write", "Do NOT use Write"},
		{"amend section", "Amending an Existing Plan"},
		{"amend rule", "amend the existing plan"},
		{"preserve deliverables", "existing deliverables"},
		{"anti AskUserQuestion for approval", "Never use AskUserQuestion to ask about plan approval"},
	}
	for _, c := range checks {
		if !strings.Contains(prompt, c.contains) {
			t.Errorf("%s: expected prompt to contain %q", c.label, c.contains)
		}
	}
}

func TestBuildPlanModePrompt_NewFile(t *testing.T) {
	prompt := buildPlanModePrompt("/tmp/plan.md", false)

	if !strings.Contains(prompt, "Create your plan at") {
		t.Error("expected 'Create your plan at' for new file")
	}
	if !strings.Contains(prompt, "Write tool") {
		t.Error("expected 'Write tool' guidance for new file")
	}
	if strings.Contains(prompt, "Amending an Existing Plan") {
		t.Error("amend section should not appear for new file")
	}
}

func TestBuildPlanModeReentryPrompt(t *testing.T) {
	prompt := buildPlanModeReentryPrompt("/tmp/plan.md")

	checks := []struct {
		label    string
		contains string
	}{
		{"reentry header", "Re-entering Plan Mode"},
		{"read existing", "Read the existing plan file"},
		{"different task", "Different task"},
		{"same task", "Same task, continuing"},
		{"adding requirements", "Adding requirements"},
	}
	for _, c := range checks {
		if !strings.Contains(prompt, c.contains) {
			t.Errorf("%s: expected prompt to contain %q", c.label, c.contains)
		}
	}
}

func TestBuildPlanModeSparseReminder_ExistingFile(t *testing.T) {
	// Create a temp file so os.Stat succeeds
	f, err := os.CreateTemp("", "plan-*.md")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.WriteString("# Existing Plan\n## Deliverable 1\n")
	f.Close()

	reminder := buildPlanModeSparseReminder(f.Name())
	if !strings.Contains(reminder, "Amend existing plan with Edit") {
		t.Error("expected amendment hint in sparse reminder for existing file")
	}
	if !strings.Contains(reminder, "Never use AskUserQuestion to ask for plan approval") {
		t.Error("expected anti-AskUserQuestion sentence in sparse reminder")
	}
}

func TestBuildPlanModeSparseReminder_NoFile(t *testing.T) {
	reminder := buildPlanModeSparseReminder("/tmp/nonexistent-plan-file-xxxxx.md")
	if strings.Contains(reminder, "Amend existing plan") {
		t.Error("amendment hint should not appear when plan file doesn't exist")
	}
}

// --- plan mode tool injection tests ---

func TestBuildToolDefs_PlanModeInjectsExitAndAsk(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test", planMode: true, planFilePath: "/tmp/plan.md"}
	opts := types.RunOptions{PlanMode: true, PlanFilePath: "/tmp/plan.md"}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)

	hasExit := false
	hasAsk := false
	for _, td := range toolDefs {
		if td.Name == "ExitPlanMode" {
			hasExit = true
		}
		if td.Name == "AskUserQuestion" {
			hasAsk = true
		}
	}
	if !hasExit {
		t.Error("expected ExitPlanMode tool in plan mode")
	}
	if !hasAsk {
		t.Error("expected AskUserQuestion tool in plan mode")
	}
}

func TestBuildToolDefs_NoPlanModeHasAskButNoExit(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{} // not plan mode
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)

	hasAsk := false
	for _, td := range toolDefs {
		if td.Name == "ExitPlanMode" {
			t.Error("ExitPlanMode sentinel should not appear outside plan mode")
		}
		if td.Name == "AskUserQuestion" {
			hasAsk = true
		}
	}
	if !hasAsk {
		t.Error("expected AskUserQuestion tool to be available outside plan mode")
	}
}

// TestBuildToolDefs_AutoModeInjectsEnterPlanMode verifies that EnterPlanMode is
// injected when not in plan mode so the LLM can request a transition.
func TestBuildToolDefs_AutoModeInjectsEnterPlanMode(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{PlanMode: false}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)

	hasEnter := false
	hasExit := false
	for _, td := range toolDefs {
		if td.Name == "EnterPlanMode" {
			hasEnter = true
		}
		if td.Name == "ExitPlanMode" {
			hasExit = true
		}
	}
	if !hasEnter {
		t.Error("expected EnterPlanMode tool in auto mode")
	}
	if hasExit {
		t.Error("ExitPlanMode should not appear in auto mode")
	}
}

// TestBuildToolDefs_PlanModeNoEnterPlanMode verifies that EnterPlanMode is NOT
// injected when already in plan mode (ExitPlanMode is instead).
func TestBuildToolDefs_PlanModeNoEnterPlanMode(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test", planMode: true, planFilePath: "/tmp/plan.md"}
	opts := types.RunOptions{PlanMode: true, PlanFilePath: "/tmp/plan.md"}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)

	hasEnter := false
	hasExit := false
	for _, td := range toolDefs {
		if td.Name == "EnterPlanMode" {
			hasEnter = true
		}
		if td.Name == "ExitPlanMode" {
			hasExit = true
		}
	}
	if hasEnter {
		t.Error("EnterPlanMode should not appear in plan mode")
	}
	if !hasExit {
		t.Error("expected ExitPlanMode tool in plan mode")
	}
}

func TestBuildSystemPrompt_PlanModeReentryPrepended(t *testing.T) {
	conv := &conversation.Conversation{}
	opts := &types.RunOptions{
		PlanMode:        true,
		PlanFilePath:    "/tmp/plan.md",
		PlanModeReentry: true,
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-7", nil)

	if !strings.Contains(result, "Re-entering Plan Mode") {
		t.Error("expected reentry prompt in system prompt")
	}
	// Reentry should come before the standard plan mode prompt
	reentryIdx := strings.Index(result, "Re-entering Plan Mode")
	planModeIdx := strings.Index(result, "[PLAN MODE]")
	if reentryIdx > planModeIdx {
		t.Error("reentry prompt should appear before standard plan mode prompt")
	}
}

// TestBuildToolDefs_ImplementationPhaseSkipsEnterPlanMode verifies that the
// engine omits the EnterPlanMode sentinel tool from the run's tool list when
// the harness has set RunOptions.ImplementationPhase=true. This replaces
// the previous prompt-text substring-matching mechanism with a structured
// boolean — see the field comment in engine/internal/types/types.go.
//
// The negative control (auto mode WITHOUT the flag injects EnterPlanMode)
// is already covered by TestBuildToolDefs_AutoModeInjectsEnterPlanMode
// above; this test is the positive-suppression case.
func TestBuildToolDefs_ImplementationPhaseSkipsEnterPlanMode(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "impl-1"}
	opts := types.RunOptions{
		ImplementationPhase: true,
		// Auto mode (PlanMode=false). EnterPlanMode would normally be
		// injected here; the flag must suppress it.
	}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)
	for _, td := range toolDefs {
		if td.Name == "EnterPlanMode" {
			t.Errorf("EnterPlanMode tool should NOT be injected when ImplementationPhase=true; found in tool list")
		}
	}
}

// TestBuildToolDefs_ImplementationPhaseIgnoredInPlanMode verifies that the
// flag is a no-op in plan mode — plan-mode runs never inject EnterPlanMode
// regardless of the flag, and the runloop's else branch (which is where
// the flag is checked) is not exercised. Locks in that the flag is
// strictly subtractive: it can only suppress, never add.
func TestBuildToolDefs_ImplementationPhaseIgnoredInPlanMode(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "impl-plan"}
	opts := types.RunOptions{
		PlanMode:            true,
		ImplementationPhase: true,
	}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)
	for _, td := range toolDefs {
		if td.Name == "EnterPlanMode" {
			t.Errorf("EnterPlanMode tool should NOT be injected in plan mode; found in tool list")
		}
	}
}

// TestBuildToolDefs_EnterPlanModeDescriptionDefault verifies that an
// auto-mode run with no harness-supplied EnterPlanModeDescription gets
// the engine's neutral one-line default as the tool description.
// Pins the ADR-004 contract that the engine ships only the mechanism
// and a minimal fallback — no policy prose.
func TestBuildToolDefs_EnterPlanModeDescriptionDefault(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "desc-default"}
	opts := types.RunOptions{PlanMode: false}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)
	var enter *types.LlmToolDef
	for i := range toolDefs {
		if toolDefs[i].Name == "EnterPlanMode" {
			enter = &toolDefs[i]
			break
		}
	}
	if enter == nil {
		t.Fatal("EnterPlanMode tool missing in auto mode with empty harness description")
	}
	// Expect the engine's default fallback. The exact string is owned
	// by tools/enter_plan_mode.go (enterPlanModeDefaultDescription);
	// we assert the structural property (short, single sentence)
	// rather than the literal string to avoid coupling.
	if len(enter.Description) > 120 {
		t.Errorf("EnterPlanMode default description is suspiciously long (%d chars); policy prose belongs in the harness per ADR-004: %q", len(enter.Description), enter.Description)
	}
	if !strings.Contains(enter.Description, "plan mode") {
		t.Errorf("EnterPlanMode default description should at least mention 'plan mode'; got %q", enter.Description)
	}
}

// TestBuildToolDefs_EnterPlanModeDescriptionHarnessOverride verifies
// that a harness-supplied RunOptions.EnterPlanModeDescription is
// forwarded verbatim as the tool description.
func TestBuildToolDefs_EnterPlanModeDescriptionHarnessOverride(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "desc-override"}
	harnessProse := "Custom harness prose for test plan workflow.\n\nUse when: cross-system integration test required."
	opts := types.RunOptions{
		PlanMode:                 false,
		EnterPlanModeDescription: harnessProse,
	}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)
	var enter *types.LlmToolDef
	for i := range toolDefs {
		if toolDefs[i].Name == "EnterPlanMode" {
			enter = &toolDefs[i]
			break
		}
	}
	if enter == nil {
		t.Fatal("EnterPlanMode tool missing in auto mode with harness description")
	}
	if enter.Description != harnessProse {
		t.Errorf("harness-supplied EnterPlanModeDescription must be forwarded verbatim; got %q want %q", enter.Description, harnessProse)
	}
}

// --- PlanModeSparseReminder override resolution tests (Fix 3) ---

// TestPlanModeSparseReminderOverride_RunOptions verifies that
// RunOptions.PlanModeSparseReminder is cached on the activeRun at startup.
// The override is applied in StartRunWithConfig; we exercise it by setting the
// field on RunOptions and checking the resulting activeRun state.
func TestPlanModeSparseReminderOverride_RunOptions(t *testing.T) {
	b := NewApiBackend()
	customReminder := "CUSTOM SPARSE REMINDER TEXT"
	opts := types.RunOptions{
		Prompt:                  "hi",
		PlanMode:                true,
		PlanFilePath:            "/tmp/test-plan.md",
		PlanModeSparseReminder:  customReminder,
		// Minimal required field to not crash startRunWithConfig
	}
	// StartRunWithConfig creates an activeRun with the override pre-cached.
	// Call it and immediately read the run state (it will fail the LLM call
	// but we can inspect the initial run struct via the active run registry).
	reqID := "test-sparse-override"
	b.StartRunWithConfig(reqID, opts, nil)
	b.mu.Lock()
	run := b.activeRuns[reqID]
	b.mu.Unlock()

	if run == nil {
		t.Fatal("activeRun not found after StartRunWithConfig")
	}
	if run.planModeSparseReminderOverride != customReminder {
		t.Errorf("planModeSparseReminderOverride: want %q got %q", customReminder, run.planModeSparseReminderOverride)
	}
	// Cancel to not leave the goroutine running.
	run.cancel()
}

// TestPlanModeSparseReminderOverride_HookResult verifies that the
// plan_mode_prompt hook's SparseReminder field is captured on the activeRun
// when RunOptions.PlanModeSparseReminder is empty (hook wins when no RunOptions
// override is set).
func TestPlanModeSparseReminderOverride_HookResult(t *testing.T) {
	hookReminder := "HOOK SPARSE REMINDER"
	run := &activeRun{requestID: "hook-sparse-test"}
	conv := &conversation.Conversation{}
	opts := &types.RunOptions{
		PlanMode:     true,
		PlanFilePath: "/tmp/plan.md",
		// PlanModeSparseReminder is empty — hook should win
	}
	hooks := RunHooks{
		OnPlanModePrompt: func(planFilePath string) (string, []string, string) {
			return "", nil, hookReminder
		},
	}

	buildSystemPrompt(opts, conv, hooks, "hook-sparse-test", run)

	if run.planModeSparseReminderOverride != hookReminder {
		t.Errorf("hook SparseReminder not cached: want %q got %q", hookReminder, run.planModeSparseReminderOverride)
	}
}

// TestPlanModeSparseReminderOverride_RunOptionsWinsOverHook verifies that
// RunOptions.PlanModeSparseReminder takes precedence over the hook result.
func TestPlanModeSparseReminderOverride_RunOptionsWinsOverHook(t *testing.T) {
	runOptionsReminder := "RUN OPTIONS REMINDER"
	hookReminder := "HOOK REMINDER"
	run := &activeRun{
		requestID:                     "runoptions-wins",
		planModeSparseReminderOverride: runOptionsReminder, // pre-set from StartRunWithConfig
	}
	conv := &conversation.Conversation{}
	opts := &types.RunOptions{
		PlanMode:               true,
		PlanFilePath:           "/tmp/plan.md",
		PlanModeSparseReminder: runOptionsReminder, // also set on opts (source of truth)
	}
	hooks := RunHooks{
		OnPlanModePrompt: func(planFilePath string) (string, []string, string) {
			return "", nil, hookReminder
		},
	}

	buildSystemPrompt(opts, conv, hooks, "runoptions-wins", run)

	// run.planModeSparseReminderOverride was pre-set from RunOptions;
	// the hook branch in buildSystemPrompt only writes when the field is empty.
	if run.planModeSparseReminderOverride != runOptionsReminder {
		t.Errorf("RunOptions reminder should win over hook: want %q got %q", runOptionsReminder, run.planModeSparseReminderOverride)
	}
}

// TestPlanModeSparseReminderOverride_DefaultWhenBothEmpty verifies that when
// neither RunOptions.PlanModeSparseReminder nor the hook provides a value,
// the run's override stays empty (engine uses buildPlanModeSparseReminder).
func TestPlanModeSparseReminderOverride_DefaultWhenBothEmpty(t *testing.T) {
	run := &activeRun{requestID: "default-reminder"}
	conv := &conversation.Conversation{}
	opts := &types.RunOptions{
		PlanMode:     true,
		PlanFilePath: "/tmp/plan.md",
		// PlanModeSparseReminder is empty
	}
	// No hook set.
	buildSystemPrompt(opts, conv, RunHooks{}, "default-reminder", run)

	if run.planModeSparseReminderOverride != "" {
		t.Errorf("expected empty override (engine will use default), got %q", run.planModeSparseReminderOverride)
	}
}

// --- loadOrCreateConversation tests ---

// TestLoadOrCreateConversation_SessionIDNotFound_CreatesNew verifies
// that when a caller supplies a SessionID that does not correspond to any
// persisted conversation file, loadOrCreateConversation creates a new
// conversation with the requested ID. This is the first-run case: the
// session doesn't exist yet, so we create it.
func TestLoadOrCreateConversation_SessionIDNotFound_CreatesNew(t *testing.T) {
	opts := types.RunOptions{
		SessionID: "nonexistent-conv-id-12345",
	}
	conv, err := loadOrCreateConversation(opts, "mock-model")
	if err != nil {
		t.Fatalf("expected no error for first-run SessionID, got %v", err)
	}
	if conv == nil {
		t.Fatal("expected non-nil conversation for first-run SessionID")
	}
	if conv.ID != opts.SessionID {
		t.Errorf("expected conversation ID=%q, got %q", opts.SessionID, conv.ID)
	}
}

// TestLoadOrCreateConversation_NoSessionID_CreatesFresh verifies the
// fresh-creation path: when SessionID is empty, loadOrCreateConversation
// must create and return a new conversation with a non-empty ID and no error.
func TestLoadOrCreateConversation_NoSessionID_CreatesFresh(t *testing.T) {
	opts := types.RunOptions{
		SessionID: "",
	}
	conv, err := loadOrCreateConversation(opts, "mock-model")
	if err != nil {
		t.Fatalf("expected no error for fresh creation, got %v", err)
	}
	if conv == nil {
		t.Fatal("expected non-nil conversation for fresh creation")
	}
	if conv.ID == "" {
		t.Error("expected fresh conversation to have a non-empty ID")
	}
}
