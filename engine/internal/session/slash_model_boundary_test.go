package session

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// tierNoticeRecorder captures engine_slash_model_tier_ignored emissions off the
// Manager's real onEvent seam, so these tests exercise the production emit path
// rather than a stand-in.
type tierNoticeRecorder struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func (r *tierNoticeRecorder) record(_ string, ev types.EngineEvent) {
	if ev.Type != "engine_slash_model_tier_ignored" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
}

func (r *tierNoticeRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func (r *tierNoticeRecorder) last() (types.EngineEvent, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.events) == 0 {
		return types.EngineEvent{}, false
	}
	return r.events[len(r.events)-1], true
}

// newTierNoticeManager builds a Manager wired to a recorder, plus the session
// key the notice is emitted on.
func newTierNoticeManager(t *testing.T) (*Manager, *tierNoticeRecorder, string) {
	t.Helper()
	const key = "tier-notice-session"
	rec := &tierNoticeRecorder{}
	mgr := &Manager{sessions: make(map[string]*engineSession)}
	mgr.sessions[key] = &engineSession{}
	mgr.onEvent = rec.record
	return mgr, rec, key
}

// TestApplySlashModelHintGate pins the one behavior that makes the boundary
// gate real: the applied flag controls opts.Model, and nothing else.
//
// Reverting the gate (making applySlashModelHint always assign opts.Model)
// turns the "declined" case red while leaving every other case green, so this
// test distinguishes the fixed behavior from the broken one rather than merely
// exercising the function.
func TestApplySlashModelHintGate(t *testing.T) {
	t.Run("declined tier does not change the serving model", func(t *testing.T) {
		opts := &types.RunOptions{Prompt: "/recap", Model: "claude-opus-5"}

		applySlashModelHint(opts, "fast", false)

		if opts.Model != "claude-opus-5" {
			t.Errorf("Model = %q, want claude-opus-5: a declined tier must not switch the model mid-conversation", opts.Model)
		}
		// Provenance still records the request. A consumer needs to know what
		// the command asked for even when the engine did not honor it.
		if opts.ResolvedSlashModelAlias != "fast" {
			t.Errorf("ResolvedSlashModelAlias = %q, want fast: the declined request is still provenance", opts.ResolvedSlashModelAlias)
		}
	})

	t.Run("applied tier selects the serving model", func(t *testing.T) {
		opts := &types.RunOptions{Prompt: "/explore", Model: "claude-opus-5"}

		applySlashModelHint(opts, "reasoning", true)

		if opts.Model != "reasoning" {
			t.Errorf("Model = %q, want reasoning: an applied tier owns model selection", opts.Model)
		}
	})

	t.Run("no declared tier leaves the model untouched regardless of gate", func(t *testing.T) {
		for _, applied := range []bool{true, false} {
			opts := &types.RunOptions{Prompt: "/spec", Model: "claude-opus-5"}

			applySlashModelHint(opts, "", applied)

			if opts.Model != "claude-opus-5" {
				t.Errorf("applied=%v: Model = %q, want claude-opus-5", applied, opts.Model)
			}
			if opts.ResolvedSlashModelAlias != "" {
				t.Errorf("applied=%v: ResolvedSlashModelAlias = %q, want empty", applied, opts.ResolvedSlashModelAlias)
			}
		}
	})
}

// TestEmitSlashModelTierIgnored pins the notice contract: the engine reports a
// declined tier exactly once, as a typed event, and stays silent otherwise.
func TestEmitSlashModelTierIgnored(t *testing.T) {
	t.Run("silent when no tier was declined", func(t *testing.T) {
		mgr, rec, key := newTierNoticeManager(t)

		mgr.emitSlashModelTierIgnored(key, &types.RunOptions{
			ResolvedSlashCommand:    "/explore",
			ResolvedSlashModelAlias: "reasoning",
			Model:                   "reasoning",
			SlashModelTierIgnored:   false,
		})

		if got := rec.count(); got != 0 {
			t.Errorf("emitted %d notices, want 0 when the tier was honored", got)
		}
	})

	t.Run("reports both the requested tier and the serving model", func(t *testing.T) {
		mgr, rec, key := newTierNoticeManager(t)

		mgr.emitSlashModelTierIgnored(key, &types.RunOptions{
			ResolvedSlashCommand:    "/recap",
			ResolvedSlashModelAlias: "fast",
			Model:                   "claude-opus-5",
			SlashModelTierIgnored:   true,
		})

		ev, ok := rec.last()
		if !ok {
			t.Fatal("no engine_slash_model_tier_ignored event emitted for a declined tier")
		}
		if ev.SlashModelTierRequested != "fast" {
			t.Errorf("SlashModelTierRequested = %q, want fast", ev.SlashModelTierRequested)
		}
		if ev.SlashModelTierServing != "claude-opus-5" {
			t.Errorf("SlashModelTierServing = %q, want claude-opus-5", ev.SlashModelTierServing)
		}
		if ev.Command != "/recap" {
			t.Errorf("Command = %q, want /recap", ev.Command)
		}
		raw, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("Marshal event: %v", err)
		}
		var wire map[string]any
		if err := json.Unmarshal(raw, &wire); err != nil {
			t.Fatalf("Unmarshal event: %v", err)
		}
		if wire["type"] != "engine_slash_model_tier_ignored" || wire["command"] != "/recap" || wire["slashModelTierRequested"] != "fast" || wire["slashModelTierServing"] != "claude-opus-5" {
			t.Fatalf("wire event = %#v", wire)
		}
	})
}
