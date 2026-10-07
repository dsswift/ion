package extension

import (
	"testing"
)

type recordedHookSpan struct {
	name  string
	attrs map[string]any
	ctx   map[string]any
	ended bool
	id    string
}

func (s *recordedHookSpan) SpanID() string { return s.id }
func (s *recordedHookSpan) End(map[string]any, ...string) {
	s.ended = true
}

// One group fire is one hook.fanout span: it names the hook and the host
// count, joins the run's trace under the run's span, and every host sees a
// context carrying the fan-out's span-id so its hook call parents under it.
// The span ends once every host has answered.
func TestGroupFireRecordsHookFanoutSpan(t *testing.T) {
	a, b := NewHost(), NewHost()
	var seen []string
	for _, h := range []*Host{a, b} {
		h.SDK().On(HookTurnStart, func(ctx *Context, _ interface{}) (interface{}, error) {
			seen = append(seen, ctx.HookFanoutSpanID)
			return nil, nil
		})
	}
	group := NewExtensionGroup()
	group.Add(a)
	group.Add(b)
	var spans []*recordedHookSpan
	group.SetSpanStarter(func(name string, attrs, ctx map[string]any) HookSpan {
		s := &recordedHookSpan{name: name, attrs: attrs, ctx: ctx, id: "aaaabbbbccccdddd"}
		spans = append(spans, s)
		return s
	})

	ctx := &Context{SessionKey: "sess-1", ConversationID: "conv-1", TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", RunSpanID: "00f067aa0ba902b7"}
	group.FireTurnStart(ctx, TurnInfo{TurnNumber: 1})

	if len(spans) != 1 {
		t.Fatalf("spans = %d, want one hook.fanout per fire", len(spans))
	}
	s := spans[0]
	if s.name != "hook.fanout" || s.attrs["hook"] != "turn_start" || s.attrs["hosts"] != 2 || !s.ended {
		t.Fatalf("span = %+v", s)
	}
	if s.ctx["trace_id"] != ctx.TraceID || s.ctx["parent_span_id"] != ctx.RunSpanID || s.ctx["session_id"] != "sess-1" || s.ctx["conversation_id"] != "conv-1" {
		t.Fatalf("span ctx = %v", s.ctx)
	}
	if len(seen) != 2 || seen[0] != "aaaabbbbccccdddd" || seen[1] != "aaaabbbbccccdddd" {
		t.Fatalf("hosts saw fan-out span ids %v", seen)
	}
	if ctx.HookFanoutSpanID != "" {
		t.Fatal("the caller's context must not be mutated")
	}
}

// Without a starter, or with no hosts, a fire records nothing and the
// context is handed on unchanged.
func TestGroupFanoutWithoutStarterIsNoop(t *testing.T) {
	group := NewExtensionGroup()
	h := NewHost()
	var got *Context
	h.SDK().On(HookTurnEnd, func(ctx *Context, _ interface{}) (interface{}, error) {
		got = ctx
		return nil, nil
	})
	group.Add(h)
	ctx := &Context{SessionKey: "s"}
	group.FireTurnEnd(ctx, TurnInfo{})
	// The SDK hands each handler its own identity-stamped copy, so compare
	// what the fan-out would have added, not the pointer.
	if got == nil || got.HookFanoutSpanID != "" || got.SessionKey != "s" {
		t.Fatalf("handler context = %+v, want the caller's context with no fan-out span", got)
	}
	calls := 0
	empty := NewExtensionGroup()
	empty.SetSpanStarter(func(string, map[string]any, map[string]any) HookSpan { calls++; return nil })
	empty.FireTurnEnd(ctx, TurnInfo{})
	if calls != 0 {
		t.Fatalf("an empty group recorded %d spans", calls)
	}
}
