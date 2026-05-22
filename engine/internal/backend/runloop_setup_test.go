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
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-1")
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
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-2")
	if result != "new system prompt" {
		t.Errorf("expected SystemPrompt override, got %q", result)
	}
}

func TestBuildSystemPrompt_PreservedWhenNoAppend(t *testing.T) {
	conv := &conversation.Conversation{
		System: "preserved system",
	}
	opts := &types.RunOptions{} // no SystemPrompt, no AppendSystemPrompt
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-3")
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
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-4")
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
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-5")
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
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-6")
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

func TestBuildSystemPrompt_PlanModeReentryPrepended(t *testing.T) {
	conv := &conversation.Conversation{}
	opts := &types.RunOptions{
		PlanMode:        true,
		PlanFilePath:    "/tmp/plan.md",
		PlanModeReentry: true,
	}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-7")

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
