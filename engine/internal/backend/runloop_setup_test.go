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
