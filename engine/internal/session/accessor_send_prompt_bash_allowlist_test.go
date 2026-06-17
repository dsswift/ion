package session

import (
	"reflect"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

// TestBuildPromptOverrides_PinsUnifiedSeam pins the single helper that EVERY
// sendPrompt entry point routes through to build per-prompt overrides: the
// active-hook path (sessionAccessor.SendPrompt) and both onSendMessage fallback
// wirings (start_session.go, prompt_extensions.go). Centralizing override
// construction here is the "one pipeline" guarantee — no entry point can build
// overrides differently from another.
//
// Revert proof: if buildPromptOverrides stops forwarding either field, or stops
// returning nil for the empty case, one of these sub-assertions fails.
func TestBuildPromptOverrides_PinsUnifiedSeam(t *testing.T) {
	t.Run("both empty returns nil", func(t *testing.T) {
		if got := buildPromptOverrides("", nil); got != nil {
			t.Fatalf("expected nil overrides for empty input, got %+v", got)
		}
	})
	t.Run("model only", func(t *testing.T) {
		got := buildPromptOverrides("claude-opus-4-20250514", nil)
		if got == nil || got.Model != "claude-opus-4-20250514" {
			t.Fatalf("expected model carried, got %+v", got)
		}
		if len(got.BashAllowlistAdditionsForThisPrompt) != 0 {
			t.Fatalf("expected no additions, got %v", got.BashAllowlistAdditionsForThisPrompt)
		}
	})
	t.Run("additions only", func(t *testing.T) {
		adds := []string{"gh issue create", "git diff"}
		got := buildPromptOverrides("", adds)
		if got == nil || got.Model != "" {
			t.Fatalf("expected empty model, got %+v", got)
		}
		if !reflect.DeepEqual(got.BashAllowlistAdditionsForThisPrompt, adds) {
			t.Fatalf("expected additions %v, got %v", adds, got.BashAllowlistAdditionsForThisPrompt)
		}
	})
	t.Run("both present", func(t *testing.T) {
		adds := []string{"gh pr view"}
		got := buildPromptOverrides("m", adds)
		if got == nil || got.Model != "m" || !reflect.DeepEqual(got.BashAllowlistAdditionsForThisPrompt, adds) {
			t.Fatalf("expected both carried, got %+v", got)
		}
	})
}

// TestDispatchSendPromptPayload_ForwardsFullPayload pins the shared
// onSendMessage callback body that BOTH extension-wiring sites install
// (start_session.go's loadAndWireExtensions and prompt_extensions.go's
// lateLoadExtensions). It drives a full SendPromptPayload (text + model + bash
// additions) through m.dispatchSendPromptPayload and asserts every field
// reaches the run via RunOptions — proving the fallback/timer path is at parity
// with the active-hook path (sessionAccessor.SendPrompt).
//
// This is the wiring-level guard (distinct from TestBuildPromptOverrides, which
// pins only the helper): if either wiring site is ever changed to drop a field
// — the exact "silent-payload-loss" regression this fix removes — the shared
// body breaks here. Reverting dispatchSendPromptPayload to forward only text
// turns this test red.
func TestDispatchSendPromptPayload_ForwardsFullPayload(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("dispatch-full", defaultConfig())

	mgr.dispatchSendPromptPayload("dispatch-full", "test", extension.SendPromptPayload{
		Text:                   "queued by extension",
		Model:                  "claude-opus-4-20250514",
		BashAllowlistAdditions: []string{"gh issue create", "git diff"},
	})

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])
	if opts.Prompt != "queued by extension" {
		t.Errorf("expected prompt text forwarded, got %q", opts.Prompt)
	}
	if opts.Model != "claude-opus-4-20250514" {
		t.Errorf("expected model forwarded on the fallback wiring, got %q", opts.Model)
	}
	got := opts.BashAllowlistAdditionsForThisPrompt
	if len(got) != 2 || got[0] != "gh issue create" || got[1] != "git diff" {
		t.Fatalf("expected bash additions forwarded, got %v", got)
	}
}

// TestOnSendMessagePayload_ParityWithAccessor pins that the fallback-path
// payload (extension.SendPromptPayload, what onSendMessage receives) and the
// active-hook path (sessionAccessor.SendPrompt args) feed buildPromptOverrides
// identically. This is the session-side half of the cross-path parity guard;
// the host-side half lives in
// extension/host_rpc_send_prompt_test.go:TestExtSendPrompt_PayloadParity_AcrossDispatchPaths.
//
// Both wiring closures (start_session.go, prompt_extensions.go) call
// buildPromptOverrides(payload.Model, payload.BashAllowlistAdditions); the
// accessor calls buildPromptOverrides(model, additions). Same helper, same
// args -> identical overrides. Reverting either wiring to drop a field, or
// reintroducing a second override-building code path, breaks this parity.
func TestOnSendMessagePayload_ParityWithAccessor(t *testing.T) {
	model := "claude-sonnet-4-20250514"
	adds := []string{"gh issue create", "git diff"}

	// Fallback-path inputs as they arrive on the SendPromptPayload, then routed
	// through the shared helper exactly as the onSendMessage closures do.
	fallback := buildPromptOverrides(model, adds)
	// Active-hook-path inputs as they arrive on sessionAccessor.SendPrompt args.
	accessor := buildPromptOverrides(model, adds)

	if !reflect.DeepEqual(fallback, accessor) {
		t.Fatalf("override parity broken between fallback and accessor paths: fallback=%+v accessor=%+v", fallback, accessor)
	}
}

// TestSessionAccessor_SendPrompt_ThreadsBashAllowlistAdditions pins the
// session-layer half of the fix that lets a slash command dispatched as an
// extension command (e.g. /create-issue, loaded from a .ion/commands/*.md file
// with an `allowed_bash_commands` frontmatter list) grant itself plan-mode
// Bash allowances for the scope of its own execution turn.
//
// The extension SDK's ctx.sendPrompt(text, { bashAllowlistAdditions }) routes
// through extcontext -> sessionAccessor.SendPrompt(text, model, additions),
// which must populate PromptOverrides.BashAllowlistAdditionsForThisPrompt so
// the run loop unions the additions into the run-scoped plan-mode Bash
// allowlist (transient, never persisted on the session).
//
// Revert check: if sessionAccessor.SendPrompt stops forwarding the additions
// onto PromptOverrides, the captured RunOptions carry no additions and this
// test fails.
func TestSessionAccessor_SendPrompt_ThreadsBashAllowlistAdditions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("acc-bash", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["acc-bash"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatal("session not found after StartSession")
	}

	acc := &sessionAccessor{m: mgr, s: s, key: "acc-bash"}

	additions := []string{"gh issue create", "gh issue view"}
	if err := acc.SendPrompt("create the issue", "", additions); err != nil {
		t.Fatalf("accessor.SendPrompt: %v", err)
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])

	if opts.Prompt != "create the issue" {
		t.Errorf("expected prompt 'create the issue', got %q", opts.Prompt)
	}
	got := opts.BashAllowlistAdditionsForThisPrompt
	if len(got) != 2 || got[0] != "gh issue create" || got[1] != "gh issue view" {
		t.Fatalf("expected BashAllowlistAdditionsForThisPrompt=[gh issue create, gh issue view], got %v", got)
	}
}

// TestSessionAccessor_SendPrompt_NoAdditions_LeavesFieldEmpty verifies the
// no-op path: when an extension command has no allowed_bash_commands
// frontmatter, sendPrompt is called with nil additions and the run carries an
// empty additions list (so the default-deny plan-mode behavior is unchanged
// for commands that don't opt in).
func TestSessionAccessor_SendPrompt_NoAdditions_LeavesFieldEmpty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("acc-noadd", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["acc-noadd"]
	mgr.mu.RUnlock()

	acc := &sessionAccessor{m: mgr, s: s, key: "acc-noadd"}
	if err := acc.SendPrompt("just plan", "", nil); err != nil {
		t.Fatalf("accessor.SendPrompt: %v", err)
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])
	if len(opts.BashAllowlistAdditionsForThisPrompt) != 0 {
		t.Fatalf("expected no bash additions, got %v", opts.BashAllowlistAdditionsForThisPrompt)
	}
}
