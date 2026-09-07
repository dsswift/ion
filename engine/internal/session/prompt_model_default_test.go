package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// prompt_model_default_test.go — pins the model half of applyConfigDefaults.
//
// A conversation that dispatches a run with no explicit model (e.g. a slash
// command with no frontmatter `model:` field) falls through to engine.json's
// global DefaultModel. That fallback can silently switch provider away from
// whatever the conversation had actually been using -- the bug this file
// guards is a missing observability signal on that branch, not the fallback
// itself (the fallback is legitimate default behavior). The desktop-side fix
// (send-slice.ts resolvePromptModel) is what stops the model from arriving
// empty in the common case; this test pins that applyConfigDefaults keeps
// doing exactly what it says when a caller does hit the fallback branch, so a
// future edit can't quietly change whose model wins.

// Nobody supplied a model -> the engine.json default fills it in.
func TestApplyConfigDefaults_ModelInheritedWhenUnset(t *testing.T) {
	m := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "dci-marketing/claude-sonnet-5"}}
	opts := types.RunOptions{}

	m.applyConfigDefaults(&opts)

	if opts.Model != "dci-marketing/claude-sonnet-5" {
		t.Fatalf("Model = %q; want engine.json defaultModel to fill the empty field", opts.Model)
	}
}

// A caller-supplied model must never be overwritten by the config default.
func TestApplyConfigDefaults_ModelPreservedWhenSet(t *testing.T) {
	m := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "dci-marketing/claude-sonnet-5"}}
	opts := types.RunOptions{Model: "anthropic/claude-sonnet-5"}

	m.applyConfigDefaults(&opts)

	if opts.Model != "anthropic/claude-sonnet-5" {
		t.Fatalf("Model = %q; want the caller-supplied model preserved, not overwritten by defaultModel", opts.Model)
	}
}
