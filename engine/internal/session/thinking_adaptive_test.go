package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinking_adaptive_test.go — pins the "adaptive" per-prompt sentinel.
//
// An Anthropic adaptive model self-regulates reasoning depth. Sending an
// explicit effort ALSO emits output_config:{effort:<level>}, which overrides
// that judgment on every turn — including turns that need no reasoning. In
// practice that produced multi-minute thinking streams on trivial prompts,
// because a default of "high" pinned maximum reasoning permanently.
//
// "adaptive" is the value a client sends to mean "reason, but you choose the
// depth": Enabled with NO Effort, so providers.resolveThinking returns
// Mode:"adaptive" Effort:"" and the Anthropic body-builder omits
// output_config entirely.
//
// The three states are genuinely distinct and must stay distinct:
//
//	off      → Thinking nil            → no directive at all
//	adaptive → {Enabled:true}          → directive, model picks depth
//	high     → {Enabled:true,Effort:h} → directive, depth pinned
//
// Revert proof: routing "adaptive" through the generic effort arm sets
// Effort:"adaptive", which fails both the effort-empty assertion here and the
// model-rejects-effort guard in resolveThinking (adaptive is not in any
// model's ThinkingEfforts list), silently disabling thinking altogether.
func TestBuildRunOptions_AdaptiveEffort(t *testing.T) {
	newSession := func() *engineSession {
		return &engineSession{config: types.EngineConfig{WorkingDirectory: "/tmp"}}
	}

	t.Run("adaptive enables thinking without pinning effort", func(t *testing.T) {
		opts := buildRunOptions(newSession(), "hi", &PromptOverrides{
			ThinkingEffort: types.ThinkingEffortAdaptive,
		})
		if opts.Thinking == nil {
			t.Fatal("Thinking nil; want enabled with no effort")
		}
		if !opts.Thinking.Enabled {
			t.Error("Enabled = false, want true — adaptive still requests thinking")
		}
		if opts.Thinking.Effort != "" {
			t.Errorf("Effort = %q, want empty so the model self-regulates depth", opts.Thinking.Effort)
		}
		if opts.ThinkingCleared {
			t.Error("ThinkingCleared = true; adaptive is not a clear")
		}
	})

	t.Run("adaptive overrides a pinned session default", func(t *testing.T) {
		s := newSession()
		s.config.Thinking = &types.ThinkingConfig{Enabled: true, Effort: "high"}
		opts := buildRunOptions(s, "hi", &PromptOverrides{
			ThinkingEffort: types.ThinkingEffortAdaptive,
		})
		if opts.Thinking == nil || opts.Thinking.Effort != "" {
			t.Errorf("Thinking = %+v, want enabled with empty effort", opts.Thinking)
		}
	})

	t.Run("adaptive is distinct from off", func(t *testing.T) {
		adaptive := buildRunOptions(newSession(), "hi", &PromptOverrides{
			ThinkingEffort: types.ThinkingEffortAdaptive,
		})
		off := buildRunOptions(newSession(), "hi", &PromptOverrides{
			ThinkingEffort: types.ThinkingEffortOff,
		})
		if adaptive.Thinking == nil {
			t.Fatal("adaptive produced no thinking config")
		}
		if off.Thinking != nil {
			t.Fatalf("off produced %+v, want nil", off.Thinking)
		}
		if !off.ThinkingCleared {
			t.Error("off did not set ThinkingCleared")
		}
		if adaptive.ThinkingCleared {
			t.Error("adaptive set ThinkingCleared; it is not a clear")
		}
	})

	t.Run("explicit levels still pin effort", func(t *testing.T) {
		for _, lvl := range []string{"low", "medium", "high"} {
			opts := buildRunOptions(newSession(), "hi", &PromptOverrides{ThinkingEffort: lvl})
			if opts.Thinking == nil || opts.Thinking.Effort != lvl {
				t.Errorf("%s: Thinking = %+v, want effort pinned to %s", lvl, opts.Thinking, lvl)
			}
		}
	})
}

// An engine.json default must not resurrect a pinned effort over an explicit
// adaptive request: adaptive is an opinion ("you choose"), not an absence of
// one, so applyConfigDefaults must leave it alone.
func TestApplyConfigDefaults_AdaptiveBeatsEngineDefault(t *testing.T) {
	m := &Manager{config: &types.EngineRuntimeConfig{
		DefaultModel: "test-model",
		Thinking:     &types.ThinkingConfig{Enabled: true, Effort: "high"},
	}}
	s := &engineSession{config: types.EngineConfig{WorkingDirectory: "/tmp"}}

	opts := buildRunOptions(s, "hi", &PromptOverrides{
		ThinkingEffort: types.ThinkingEffortAdaptive,
	})
	m.applyConfigDefaults(&opts)

	if opts.Thinking == nil {
		t.Fatal("Thinking nil after defaults; adaptive should have survived")
	}
	if opts.Thinking.Effort != "" {
		t.Errorf("Effort = %q, want empty — the engine default must not pin depth over adaptive", opts.Thinking.Effort)
	}
}
