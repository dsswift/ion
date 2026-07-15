package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestFireBeforePromptCli_CtxModelIsSelectedModel pins the routing→payload
// handoff: model_select picks the model, and the before_prompt handler that
// runs afterward must see that chosen model on ctx.Model. Reverting the
// ctx.Model population in fireBeforePromptCli turns this red (ctx.Model is nil,
// so gotModelID stays empty).
func TestFireBeforePromptCli_CtxModelIsSelectedModel(t *testing.T) {
	cb := backend.NewClaudeCodeBackend()
	mgr := NewManager(cb)
	s := newCliSession("bp-model")

	// model_select handler routes the run to a specific model.
	const selected = "claude-opus-4-20250514"
	host := extension.NewHost()
	host.SDK().On(extension.HookModelSelect, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		return selected, nil
	})

	// before_prompt handler captures the model it observes on ctx.
	var gotModelID string
	host.SDK().On(extension.HookBeforePrompt, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		if ctx.Model != nil {
			gotModelID = ctx.Model.ID
		}
		return nil, nil
	})

	group := extension.NewExtensionGroup()
	group.Add(host)
	s.extGroup = group

	opts := types.RunOptions{
		Prompt: "route me based on content",
		Model:  "claude-sonnet-4-20250514",
	}

	// Stage 1: model_select routes on the raw prompt and overrides opts.Model.
	mgr.fireModelSelect(s, "bp-model", group, false, &opts)
	if opts.Model != selected {
		t.Fatalf("expected model_select to override model to %q, got %q", selected, opts.Model)
	}

	// Stage 2: before_prompt runs with ctx.Model set to the SELECTED model.
	mgr.fireBeforePromptCli(s, "bp-model", group, false, &opts)
	if gotModelID != selected {
		t.Fatalf("expected before_prompt handler to see ctx.Model.ID == %q, got %q", selected, gotModelID)
	}
}
