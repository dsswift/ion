package scheduling

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Each schedule fire runs under a trace of its own, rooted at the fire, on a
// copy of the resolved session context.
func TestFireTraceContextMintsPerFire(t *testing.T) {
	resolved := &extension.Context{SessionKey: "sess"}
	job := extension.ScheduleJob{JobID: "morning-brief"}
	first := fireTraceContext(resolved, job)
	second := fireTraceContext(resolved, job)
	for _, ctx := range []*extension.Context{first, second} {
		if !utils.IsValidTraceID(ctx.TraceID) || !utils.IsValidSpanID(ctx.RunSpanID) {
			t.Errorf("fire context trace/span = %q/%q", ctx.TraceID, ctx.RunSpanID)
		}
		if ctx.SessionKey != "sess" || ctx.RunID != "" {
			t.Errorf("fire context = %+v, want the session with no run", ctx)
		}
	}
	if first.TraceID == second.TraceID {
		t.Errorf("two fires share trace %q", first.TraceID)
	}
	if resolved.TraceID != "" || resolved.RunSpanID != "" {
		t.Errorf("resolver context mutated: %+v", resolved)
	}
	if got := extension.FireTraceparent(first); got != utils.FormatTraceparent(first.TraceID, first.RunSpanID) {
		t.Errorf("prompt traceparent for the fire = %q", got)
	}
}
