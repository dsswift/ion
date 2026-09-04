package session

// TestSendPrompt_EmptyExtensions_IdenticalDispatchPath pins the conversation-
// unification contract (issue #256, phase 0): a session started with an empty
// extension list (Extensions: nil or Extensions: []string{}) dispatches through
// the identical code path as a session started with extensions present.
//
// The invariant is structural: lateLoadExtensions early-returns for both nil
// and empty Extensions slices, leaving s.extGroup unchanged (nil). Downstream,
// fireBeforeAgentStart / fireModelSelect / buildRunConfig / StartRun all guard
// on extGroup == nil || extGroup.IsEmpty() and produce the same behaviour
// regardless of whether the caller passed Extensions: nil or Extensions: [].
//
// This is NOT a behavioural equivalence test for the extension host. It pins
// the session-layer guarantee that "no extensions" (however expressed) never
// forks into a separate prompt-dispatch branch.
//
// Revert check: if a hidden plain-vs-hosted branch is ever introduced inside
// SendPrompt (e.g. an early-exit or alternate StartRun call gated on
// len(Extensions) == 0), one of the sub-tests below will show that only one
// path produced a backend run, or that the RunOptions differ unexpectedly.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestLateLoadExtensions_NilVsEmptySlice_NoopEquivalence asserts that
// lateLoadExtensions treats nil and []string{} identically: it returns
// immediately without touching s.extGroup in both cases. The session's extGroup
// remains nil post-call.
func TestLateLoadExtensions_NilVsEmptySlice_NoopEquivalence(t *testing.T) {
	for _, tc := range []struct {
		name string
		exts []string
	}{
		{"nil extensions", nil},
		{"empty slice extensions", []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mb := newMockBackend()
			mgr := NewManager(mb)
			_, _ = mgr.StartSession("late-load-"+tc.name, defaultConfig())

			mgr.mu.RLock()
			s := mgr.sessions["late-load-"+tc.name]
			mgr.mu.RUnlock()
			if s == nil {
				t.Fatal("session not found")
			}

			// extGroup starts nil (no extensions at session start)
			if s.extGroup != nil {
				t.Fatalf("expected nil extGroup before call, got non-nil")
			}

			var overrides *PromptOverrides
			if tc.exts != nil {
				overrides = &PromptOverrides{Extensions: tc.exts}
			}

			// lateLoadExtensions is self-locking (off-lock context-injection
			// refactor): caller must NOT hold mgr.mu when calling it.
			mgr.lateLoadExtensions(s, "late-load-"+tc.name, overrides)

			// extGroup must still be nil: lateLoadExtensions must have returned
			// immediately without installing any extension group.
			if s.extGroup != nil {
				t.Fatalf("%s: expected extGroup nil after no-op lateLoad, got non-nil", tc.name)
			}
		})
	}
}

// TestSendPrompt_NilExtensions_ReachesBackend asserts that a session with no
// extensions (nil overrides) still dispatches to the backend — no silent drop.
func TestSendPrompt_NilExtensions_ReachesBackend(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-ext-nil", defaultConfig())

	if err := mgr.SendPrompt("no-ext-nil", "hello from nil-ext session", nil); err != nil {
		t.Fatalf("SendPrompt (nil extensions): %v", err)
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 backend run, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])
	if opts.Prompt != "hello from nil-ext session" {
		t.Errorf("expected prompt forwarded to backend, got %q", opts.Prompt)
	}
}

// TestSendPrompt_EmptyExtensionSlice_ReachesBackend asserts that an explicit
// empty extensions slice (Extensions: []string{}) also dispatches to the backend
// — the empty slice is not special-cased as a "no-run" or "plain" mode signal.
func TestSendPrompt_EmptyExtensionSlice_ReachesBackend(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-ext-empty", defaultConfig())

	overrides := &PromptOverrides{Extensions: []string{}}
	if err := mgr.SendPrompt("no-ext-empty", "hello from empty-ext session", overrides); err != nil {
		t.Fatalf("SendPrompt (empty Extensions slice): %v", err)
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 backend run, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])
	if opts.Prompt != "hello from empty-ext session" {
		t.Errorf("expected prompt forwarded to backend, got %q", opts.Prompt)
	}
}

// TestSendPrompt_NilVsEmptyExtensions_IdenticalRunOptions asserts that the
// RunOptions reaching the backend are structurally identical for the nil-
// extensions and empty-extensions cases. The prompt path must not inject any
// extra field, flag, or system-prompt content that distinguishes the two.
func TestSendPrompt_NilVsEmptyExtensions_IdenticalRunOptions(t *testing.T) {
	const promptText = "contract pin: no hidden branch"

	runFor := func(extSlice []string) types.RunOptions {
		mb := newMockBackend()
		mgr := NewManager(mb)
		cfg := defaultConfig()
		_, _ = mgr.StartSession("branch-pin", cfg)

		var overrides *PromptOverrides
		if extSlice != nil {
			overrides = &PromptOverrides{Extensions: extSlice}
		}

		if err := mgr.SendPrompt("branch-pin", promptText, overrides); err != nil {
			t.Fatalf("SendPrompt: %v", err)
		}

		keys := mb.startedKeys()
		if len(keys) != 1 {
			t.Fatalf("expected 1 run, got %d", len(keys))
		}
		opts, _ := mb.getStarted(keys[0])
		return opts
	}

	nilOpts := runFor(nil)
	emptyOpts := runFor([]string{})

	// Core prompt must be identical.
	if nilOpts.Prompt != emptyOpts.Prompt {
		t.Errorf("Prompt differs: nil=%q empty=%q", nilOpts.Prompt, emptyOpts.Prompt)
	}

	// ProjectPath must be identical (no path manipulation by any ext-present branch).
	if nilOpts.ProjectPath != emptyOpts.ProjectPath {
		t.Errorf("ProjectPath differs: nil=%q empty=%q", nilOpts.ProjectPath, emptyOpts.ProjectPath)
	}

	// AppendSystemPrompt must be identical (fireBeforeAgentStart must be a no-op
	// for both, since extGroup is nil in both cases).
	if nilOpts.AppendSystemPrompt != emptyOpts.AppendSystemPrompt {
		t.Errorf("AppendSystemPrompt differs: nil=%q empty=%q",
			nilOpts.AppendSystemPrompt, emptyOpts.AppendSystemPrompt)
	}

	// Model must be identical (fireModelSelect must be a no-op for both).
	if nilOpts.Model != emptyOpts.Model {
		t.Errorf("Model differs: nil=%q empty=%q", nilOpts.Model, emptyOpts.Model)
	}
}
