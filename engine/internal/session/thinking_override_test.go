package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinking_override_test.go — pins the per-prompt thinking-effort override
// (live per-conversation control). buildRunOptions must:
//   - set RunOptions.Thinking{Enabled:true, Effort:<level>} for a non-empty,
//     non-"off" level,
//   - clear RunOptions.Thinking to nil for "off" (overriding any default),
//   - leave Thinking untouched (nil here) when no level is supplied.
//
// Revert proof: removing the override wiring in prompt_options.go fails the
// high/low cases; removing the "off" clearing fails the off case.
func TestBuildRunOptions_ThinkingEffortOverride(t *testing.T) {
	newSession := func() *engineSession {
		return &engineSession{config: types.EngineConfig{WorkingDirectory: "/tmp"}}
	}

	t.Run("high sets effort thinking", func(t *testing.T) {
		opts := buildRunOptions(newSession(), "hi", &PromptOverrides{ThinkingEffort: "high"})
		if opts.Thinking == nil {
			t.Fatal("Thinking nil; want enabled effort=high")
		}
		if !opts.Thinking.Enabled || opts.Thinking.Effort != "high" {
			t.Errorf("Thinking = %+v, want {Enabled:true Effort:high}", opts.Thinking)
		}
	})

	t.Run("low sets effort thinking", func(t *testing.T) {
		opts := buildRunOptions(newSession(), "hi", &PromptOverrides{ThinkingEffort: "low"})
		if opts.Thinking == nil || opts.Thinking.Effort != "low" {
			t.Errorf("Thinking = %+v, want effort=low", opts.Thinking)
		}
	})

	t.Run("off clears thinking", func(t *testing.T) {
		// Even if the session somehow carried a default, "off" must win.
		s := newSession()
		s.config.Thinking = &types.ThinkingConfig{Enabled: true, Effort: "high"}
		opts := buildRunOptions(s, "hi", &PromptOverrides{ThinkingEffort: "off"})
		if opts.Thinking != nil {
			t.Errorf("Thinking = %+v, want nil for off", opts.Thinking)
		}
	})

	t.Run("empty leaves session default", func(t *testing.T) {
		s := newSession()
		s.config.Thinking = &types.ThinkingConfig{Enabled: true, Effort: "medium"}
		opts := buildRunOptions(s, "hi", &PromptOverrides{})
		if opts.Thinking == nil || opts.Thinking.Effort != "medium" {
			t.Errorf("Thinking = %+v, want session default medium preserved", opts.Thinking)
		}
	})
}
