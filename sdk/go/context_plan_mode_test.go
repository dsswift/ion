package ion

import (
	"context"
	"errors"
	"testing"
)

func planModeCall(t *testing.T, result map[string]any, call func(*Context) error) error {
	t.Helper()
	fe := newFakeEngine(t, WithName("plan-mode"))
	fe.start()
	fe.doInit(ExtensionConfig{})
	ctx := fe.sdk.newContext(nil)
	errCh := make(chan error, 1)
	go func() { errCh <- call(ctx) }()
	frame := fe.awaitMethod("ext/set_plan_mode")
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	fe.respond(id, result)
	return <-errCh
}

func TestEnterPlanMode_VetoIsTypedError(t *testing.T) {
	err := planModeCall(t, map[string]any{"ok": true, "allowed": false, "reason": "stay in auto"}, func(c *Context) error {
		return c.EnterPlanMode(context.Background())
	})
	var veto *PlanModeVetoError
	if !errors.As(err, &veto) || !veto.Enabled || veto.Reason != "stay in auto" {
		t.Fatalf("want a PlanModeVetoError carrying the reason, got %v", err)
	}
}

func TestExitPlanMode_AllowedIsNil(t *testing.T) {
	err := planModeCall(t, map[string]any{"ok": true, "allowed": true, "changed": true}, func(c *Context) error {
		return c.ExitPlanMode(context.Background())
	})
	if err != nil {
		t.Fatalf("an allowed exit must succeed: %v", err)
	}
}

// An engine older than the veto answers only {"ok":true}; that is a success,
// not a veto.
func TestEnterPlanMode_OlderEngineReplyIsAllowed(t *testing.T) {
	err := planModeCall(t, map[string]any{"ok": true}, func(c *Context) error {
		return c.EnterPlanMode(context.Background())
	})
	if err != nil {
		t.Fatalf("a reply without allowed must succeed: %v", err)
	}
}
