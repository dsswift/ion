package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

func TestWithTraceRootMintsRootAndKeepsSession(t *testing.T) {
	base := &Context{SessionKey: "sess", ConversationID: "conv", Cwd: "/w"}
	root := base.WithTraceRoot("schedule", "job-1")
	if !utils.IsValidTraceID(root.TraceID) || !utils.IsValidSpanID(root.RunSpanID) {
		t.Fatalf("root trace/span = %q/%q", root.TraceID, root.RunSpanID)
	}
	if root.SessionKey != "sess" || root.ConversationID != "conv" || root.Cwd != "/w" || root.RunID != "" {
		t.Errorf("root lost session fields or gained a run: %+v", root)
	}
	if base.TraceID != "" {
		t.Errorf("WithTraceRoot mutated the resolver's context")
	}
	second := base.WithTraceRoot("schedule", "job-1")
	if second.TraceID == root.TraceID {
		t.Errorf("two fires share a trace %q", root.TraceID)
	}
	var nilCtx *Context
	if got := nilCtx.WithTraceRoot("webhook", "/hook"); got == nil || got.TraceID == "" {
		t.Errorf("nil context must still yield a root, got %+v", got)
	}
}

func TestFireTraceparentOnlyForFireContexts(t *testing.T) {
	fire := (&Context{}).WithTraceRoot("webhook", "/hook")
	if got := FireTraceparent(fire); got != utils.FormatTraceparent(fire.TraceID, fire.RunSpanID) {
		t.Errorf("fire traceparent = %q", got)
	}
	inRun := &Context{RunID: "run", TraceID: fire.TraceID, RunSpanID: fire.RunSpanID}
	if got := FireTraceparent(inRun); got != "" {
		t.Errorf("a prompt sent inside a run must start its own trace, got %q", got)
	}
	if got := FireTraceparent(&Context{}); got != "" {
		t.Errorf("idle context yielded %q", got)
	}
}
