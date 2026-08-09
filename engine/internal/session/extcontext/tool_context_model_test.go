package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

type modelTestAccessor struct {
	noopSA
	model string
}

func (a modelTestAccessor) CurrentModel() string { return a.model }

func TestNewExtContext_Model(t *testing.T) {
	const model = "test-extcontext-current-model"
	providers.RegisterModel(model, types.ModelInfo{ContextWindow: 131072})
	t.Cleanup(providers.ResetRegistries)

	ctx := NewExtContext(modelTestAccessor{model: model}, NewDispatchRegistry())
	if ctx.Model == nil {
		t.Fatal("Model = nil, want model reference")
	}
	if ctx.Model.ID != model {
		t.Errorf("Model.ID = %q, want %q", ctx.Model.ID, model)
	}
	if ctx.Model.ContextWindow != 131072 {
		t.Errorf("Model.ContextWindow = %d, want 131072", ctx.Model.ContextWindow)
	}
}

func TestNewExtContext_EmptyModel(t *testing.T) {
	ctx := NewExtContext(modelTestAccessor{}, NewDispatchRegistry())
	if ctx.Model != nil {
		t.Errorf("Model = %#v, want nil", ctx.Model)
	}
}
