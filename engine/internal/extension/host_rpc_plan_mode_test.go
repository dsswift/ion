package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// TestHandleSetPlanMode_Enter verifies that ext/set_plan_mode with enabled:true
// calls ctx.SetPlanMode(true, source) and responds with {"ok":true}.
func TestHandleSetPlanMode_Enter(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	var gotEnabled bool
	var gotSource string
	h.ctxStack.Push(&Context{
		SetPlanMode: func(enabled bool, source string) {
			gotEnabled = enabled
			gotSource = source
		},
	})

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{
			"enabled": true,
			"source":  "safety_gate",
		},
	})
	h.handleSetPlanMode(1, raw)

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, _ := resp["result"].(map[string]interface{})
	if ok, _ := result["ok"].(bool); !ok {
		t.Errorf("result.ok = %v, want true", result)
	}
	if !gotEnabled {
		t.Errorf("SetPlanMode called with enabled=false, want true")
	}
	if gotSource != "safety_gate" {
		t.Errorf("source = %q, want safety_gate", gotSource)
	}
}

// TestHandleSetPlanMode_Exit verifies exit (enabled:false) path.
func TestHandleSetPlanMode_Exit(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	var gotEnabled bool
	h.ctxStack.Push(&Context{
		SetPlanMode: func(enabled bool, _ string) { gotEnabled = enabled },
	})

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"enabled": false, "source": "approval_loop"},
	})
	h.handleSetPlanMode(2, raw)

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	if gotEnabled {
		t.Error("SetPlanMode called with enabled=true, want false")
	}
}

// TestHandleSetPlanMode_DefaultSource verifies that an empty source falls back
// to "extension" so callers don't have to specify it.
func TestHandleSetPlanMode_DefaultSource(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	var gotSource string
	h.ctxStack.Push(&Context{
		SetPlanMode: func(_ bool, source string) { gotSource = source },
	})

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"enabled": true, "source": ""},
	})
	h.handleSetPlanMode(3, raw)
	readResponse(t, ch, time.Second)

	if gotSource != "extension" {
		t.Errorf("default source = %q, want extension", gotSource)
	}
}

// TestHandleSetPlanMode_NoCtx verifies that ext/set_plan_mode returns -32603
// when no context is wired (called outside a hook turn).
func TestHandleSetPlanMode_NoCtx(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)
	// No context pushed.

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"enabled": true},
	})
	h.handleSetPlanMode(4, raw)

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32603 {
		t.Errorf("error code = %v, want -32603", errObj)
	}
}

// TestHandleGetPlanMode_Active verifies that ext/get_plan_mode returns the
// current (enabled=true, planFilePath) state from ctx.GetPlanMode.
func TestHandleGetPlanMode_Active(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	h.ctxStack.Push(&Context{
		GetPlanMode: func() (bool, string) { return true, "/tmp/plans/my-plan.md" },
	})

	h.handleGetPlanMode(5, nil)

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, _ := resp["result"].(map[string]interface{})
	if enabled, _ := result["enabled"].(bool); !enabled {
		t.Errorf("result.enabled = %v, want true", result["enabled"])
	}
	if path, _ := result["planFilePath"].(string); path != "/tmp/plans/my-plan.md" {
		t.Errorf("result.planFilePath = %q, want /tmp/plans/my-plan.md", path)
	}
}

// TestHandleGetPlanMode_Inactive verifies that ext/get_plan_mode returns
// enabled=false when the session is not in plan mode.
func TestHandleGetPlanMode_Inactive(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	h.ctxStack.Push(&Context{
		GetPlanMode: func() (bool, string) { return false, "" },
	})

	h.handleGetPlanMode(6, nil)

	resp := readResponse(t, ch, time.Second)
	result, _ := resp["result"].(map[string]interface{})
	if enabled, _ := result["enabled"].(bool); enabled {
		t.Errorf("result.enabled = true, want false")
	}
}

// TestHandleGetPlanMode_NoCtx verifies that ext/get_plan_mode returns -32603
// when no context is available.
func TestHandleGetPlanMode_NoCtx(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)
	// No context pushed.

	h.handleGetPlanMode(7, nil)

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32603 {
		t.Errorf("error code = %v, want -32603", errObj)
	}
}
