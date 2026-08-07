package session

// Tests for the ClientWorkspaceContext → injectWorkspaceContext pipeline:
// client-supplied text, bench/data → hook payload mapping, per-prompt vs
// session-level precedence, and the nil-fallback to engine-derived context.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

func newWorkspaceTestManager(t *testing.T) *Manager {
	t.Helper()
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	t.Cleanup(func() { mgr.Shutdown() })
	return mgr
}

// ── Client-supplied text becomes system-prompt content ───────────────────────

func TestClientWorkspaceContext_TextAppendsToSystemPrompt(t *testing.T) {
	mgr := newWorkspaceTestManager(t)
	s := newPlainTestSession("ctx-text")

	clientCtx := &types.ClientWorkspaceContext{
		Kind: "bench",
		Cwd:  "/bench/project",
		Text: "You are working in an integration bench.",
	}
	var opts types.RunOptions
	mgr.injectWorkspaceContext(s, "ctx-text", &opts, clientCtx)

	if opts.AppendSystemPrompt == "" {
		t.Fatal("client-supplied Text must be appended to the system prompt")
	}
	if opts.AppendSystemPrompt != clientCtx.Text {
		t.Errorf("system prompt = %q, want %q", opts.AppendSystemPrompt, clientCtx.Text)
	}
}

func TestClientWorkspaceContext_EmptyTextDoesNotAppend(t *testing.T) {
	mgr := newWorkspaceTestManager(t)
	s := newPlainTestSession("ctx-no-text")

	clientCtx := &types.ClientWorkspaceContext{
		Kind: "bench",
		Cwd:  "/bench/project",
	}
	var opts types.RunOptions
	mgr.injectWorkspaceContext(s, "ctx-no-text", &opts, clientCtx)

	if opts.AppendSystemPrompt != "" {
		t.Errorf("empty Text must not append anything, got %q", opts.AppendSystemPrompt)
	}
}

// ── Bench/Data map to PromptContext.Bench/Client ─────────────────────────────

func TestClientWorkspaceContext_BenchAndDataMapToPromptContext(t *testing.T) {
	mgr := newWorkspaceTestManager(t)
	s := newPlainTestSession("ctx-fields")

	benchPayload := map[string]any{"benchPath": "/bench/project", "members": []any{"a", "b"}}
	dataPayload := map[string]any{"extra": "value"}
	clientCtx := &types.ClientWorkspaceContext{
		Kind:  "bench",
		Cwd:   "/bench/project",
		Bench: benchPayload,
		Data:  dataPayload,
		Text:  "bench context",
	}

	var opts types.RunOptions
	pc := mgr.injectWorkspaceContext(s, "ctx-fields", &opts, clientCtx)

	if pc == nil {
		t.Fatal("injectWorkspaceContext must return a non-nil PromptContext")
	}
	if pc.Kind != workspaces.ContextKind("bench") {
		t.Errorf("Kind = %q, want bench", pc.Kind)
	}
	if pc.Cwd != "/bench/project" {
		t.Errorf("Cwd = %q, want /bench/project", pc.Cwd)
	}
	if pc.Bench == nil {
		t.Fatal("Bench must be populated from ClientWorkspaceContext.Bench")
	}
	if pc.Bench["benchPath"] != "/bench/project" {
		t.Errorf("Bench[benchPath] = %v, want /bench/project", pc.Bench["benchPath"])
	}
	if pc.Client == nil {
		t.Fatal("Client must be populated from ClientWorkspaceContext.Data")
	}
	if pc.Client["extra"] != "value" {
		t.Errorf("Client[extra] = %v, want value", pc.Client["extra"])
	}
}

// ── Precedence: per-prompt > session-level > nil ─────────────────────────────

func TestClientWorkspaceContext_PerPromptOverridesSessionLevel(t *testing.T) {
	mgr := newWorkspaceTestManager(t)
	s := newPlainTestSession("ctx-prec")

	sessionCtx := &types.ClientWorkspaceContext{
		Kind: "worktree",
		Cwd:  "/wt/session",
		Text: "session-level context",
	}
	s.config.ClientWorkspaceContext = sessionCtx

	perPromptCtx := &types.ClientWorkspaceContext{
		Kind: "bench",
		Cwd:  "/bench/prompt",
		Text: "per-prompt context",
	}

	var opts types.RunOptions
	pc := mgr.injectWorkspaceContext(s, "ctx-prec", &opts, perPromptCtx)

	if pc == nil {
		t.Fatal("must return non-nil PromptContext")
	}
	if pc.Kind != workspaces.ContextKind("bench") {
		t.Errorf("Kind = %q, want bench (per-prompt wins)", pc.Kind)
	}
	if pc.Cwd != "/bench/prompt" {
		t.Errorf("Cwd = %q, want /bench/prompt (per-prompt wins)", pc.Cwd)
	}
	if opts.AppendSystemPrompt != "per-prompt context" {
		t.Errorf("system prompt = %q, want per-prompt text", opts.AppendSystemPrompt)
	}
}

func TestClientWorkspaceContext_SessionLevelUsedWhenNoPerPrompt(t *testing.T) {
	mgr := newWorkspaceTestManager(t)
	s := newPlainTestSession("ctx-session")

	sessionCtx := &types.ClientWorkspaceContext{
		Kind: "worktree",
		Cwd:  "/wt/session",
		Text: "session-level context",
	}
	s.config.ClientWorkspaceContext = sessionCtx

	var opts types.RunOptions
	pc := mgr.injectWorkspaceContext(s, "ctx-session", &opts, sessionCtx)

	if pc == nil {
		t.Fatal("must return non-nil PromptContext")
	}
	if pc.Kind != workspaces.ContextKind("worktree") {
		t.Errorf("Kind = %q, want worktree (session-level)", pc.Kind)
	}
	if opts.AppendSystemPrompt != "session-level context" {
		t.Errorf("system prompt = %q, want session-level text", opts.AppendSystemPrompt)
	}
}

// ── Nil clientCtx falls back to engine-derived ───────────────────────────────

func TestClientWorkspaceContext_NilFallsBackToEngineDerived(t *testing.T) {
	mgr := newWorkspaceTestManager(t)
	s := newPlainTestSession("ctx-nil")
	s.config.WorkingDirectory = "/somewhere/unregistered"

	var opts types.RunOptions
	pc := mgr.injectWorkspaceContext(s, "ctx-nil", &opts, nil)

	// With no registered worktrees and an unrelated cwd, the engine-derived
	// context is empty, so injectWorkspaceContext returns nil.
	if pc != nil {
		t.Errorf("nil clientCtx with unrelated cwd must fall back to engine-derived (nil for unrelated dir), got %+v", pc)
	}
	if opts.AppendSystemPrompt != "" {
		t.Errorf("nil clientCtx with no context must not append, got %q", opts.AppendSystemPrompt)
	}
}
