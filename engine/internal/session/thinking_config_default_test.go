package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinking_config_default_test.go — pins the three-layer precedence chain for
// extended thinking:
//
//	engine.json default  (weakest, EngineRuntimeConfig.Thinking)
//	  ← EngineConfig.Thinking      (per-session, set at start_session)
//	    ← send_prompt.thinkingEffort (strongest, per-prompt)
//
// buildRunOptions resolves the two stronger layers; applyConfigDefaults fills
// the weakest one in only when neither spoke. The subtle case — and the reason
// RunOptions.ThinkingCleared exists — is that an explicit per-prompt "off" and
// "nobody expressed an opinion" BOTH leave RunOptions.Thinking nil. Without the
// flag the engine default would be re-applied over the explicit off, and a user
// toggling thinking off would keep paying for reasoning tokens.
//
// Revert proof: dropping the applyConfigDefaults arm fails the inherit case;
// dropping ThinkingCleared fails the explicit-off case.

func managerWithThinkingDefault(cfg *types.ThinkingConfig) *Manager {
	return &Manager{config: &types.EngineRuntimeConfig{
		DefaultModel: "test-model",
		Thinking:     cfg,
	}}
}

func newThinkingSession() *engineSession {
	return &engineSession{config: types.EngineConfig{WorkingDirectory: "/tmp"}}
}

// Nobody expressed an opinion → the engine.json default applies.
func TestApplyConfigDefaults_ThinkingInheritedWhenUnset(t *testing.T) {
	m := managerWithThinkingDefault(&types.ThinkingConfig{Enabled: true, Effort: "medium"})
	opts := buildRunOptions(newThinkingSession(), "hi", nil)
	m.applyConfigDefaults(&opts)

	if opts.Thinking == nil {
		t.Fatal("Thinking nil; want the engine.json default applied")
	}
	if !opts.Thinking.Enabled || opts.Thinking.Effort != "medium" {
		t.Errorf("Thinking = %+v, want {Enabled:true Effort:medium}", opts.Thinking)
	}
}

// The per-session config is a STRONGER layer and must not be overwritten.
func TestApplyConfigDefaults_SessionConfigBeatsEngineDefault(t *testing.T) {
	m := managerWithThinkingDefault(&types.ThinkingConfig{Enabled: true, Effort: "medium"})
	s := newThinkingSession()
	s.config.Thinking = &types.ThinkingConfig{Enabled: true, Effort: "low"}

	opts := buildRunOptions(s, "hi", nil)
	m.applyConfigDefaults(&opts)

	if opts.Thinking == nil || opts.Thinking.Effort != "low" {
		t.Errorf("Thinking = %+v, want the session's low to win over the engine default", opts.Thinking)
	}
}

// The per-prompt effort is the STRONGEST layer.
func TestApplyConfigDefaults_PromptEffortBeatsEngineDefault(t *testing.T) {
	m := managerWithThinkingDefault(&types.ThinkingConfig{Enabled: true, Effort: "medium"})
	opts := buildRunOptions(newThinkingSession(), "hi", &PromptOverrides{ThinkingEffort: "high"})
	m.applyConfigDefaults(&opts)

	if opts.Thinking == nil || opts.Thinking.Effort != "high" {
		t.Errorf("Thinking = %+v, want the prompt's high to win", opts.Thinking)
	}
}

// THE case this whole design turns on: an explicit per-prompt "off" must not be
// resurrected by the engine-wide default. Both an explicit off and an absent
// opinion leave Thinking nil, so only ThinkingCleared can tell them apart.
func TestApplyConfigDefaults_ExplicitOffIsNotResurrected(t *testing.T) {
	m := managerWithThinkingDefault(&types.ThinkingConfig{Enabled: true, Effort: "medium"})
	opts := buildRunOptions(newThinkingSession(), "hi", &PromptOverrides{ThinkingEffort: "off"})

	if !opts.ThinkingCleared {
		t.Fatal("ThinkingCleared = false after an explicit off; the clear is not recorded")
	}

	m.applyConfigDefaults(&opts)

	if opts.Thinking != nil {
		t.Errorf("Thinking = %+v, want nil — an explicit off must survive the engine default", opts.Thinking)
	}
}

// Same, with a session default also in play: off beats BOTH weaker layers.
func TestApplyConfigDefaults_ExplicitOffBeatsSessionAndEngineDefaults(t *testing.T) {
	m := managerWithThinkingDefault(&types.ThinkingConfig{Enabled: true, Effort: "medium"})
	s := newThinkingSession()
	s.config.Thinking = &types.ThinkingConfig{Enabled: true, Effort: "high"}

	opts := buildRunOptions(s, "hi", &PromptOverrides{ThinkingEffort: "off"})
	m.applyConfigDefaults(&opts)

	if opts.Thinking != nil {
		t.Errorf("Thinking = %+v, want nil — off must clear both defaults", opts.Thinking)
	}
}

// No engine.json default configured → behavior is exactly as before the field
// existed: no directive unless a caller asks for one.
func TestApplyConfigDefaults_NoEngineDefaultLeavesThinkingNil(t *testing.T) {
	m := managerWithThinkingDefault(nil)
	opts := buildRunOptions(newThinkingSession(), "hi", nil)
	m.applyConfigDefaults(&opts)

	if opts.Thinking != nil {
		t.Errorf("Thinking = %+v, want nil when engine.json declares no default", opts.Thinking)
	}
}

// The applied default must be a COPY: mutating the run's config cannot reach
// back into the manager's shared config and poison every later session.
func TestApplyConfigDefaults_ThinkingDefaultIsCopied(t *testing.T) {
	shared := &types.ThinkingConfig{Enabled: true, Effort: "medium"}
	m := managerWithThinkingDefault(shared)

	opts := buildRunOptions(newThinkingSession(), "hi", nil)
	m.applyConfigDefaults(&opts)
	opts.Thinking.Effort = "high"

	if shared.Effort != "medium" {
		t.Errorf("manager config mutated through the run: Effort = %q, want medium", shared.Effort)
	}
}
