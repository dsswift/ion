package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Spans started from a run's correlation block are children of the run's span.
func TestTelemCtxFromOptionsCarriesRunSpan(t *testing.T) {
	parent := utils.WithSpanID(utils.WithTraceID(context.Background(), "4bf92f3577b34da6a3ce929d0e0e4736"), "00f067aa0ba902b7")
	ctx := telemCtxFromOptions("run-1", &types.RunOptions{ParentCtx: parent}, "conv-1")
	if ctx["trace_id"] != "4bf92f3577b34da6a3ce929d0e0e4736" || ctx["parent_span_id"] != "00f067aa0ba902b7" {
		t.Errorf("ctx = %v", ctx)
	}
}
