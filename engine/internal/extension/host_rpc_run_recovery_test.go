package extension

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestHandleSetRunRecovery_EnableWithDefaults(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	var got *types.RunRecoveryConfig
	h.ctxStack.Push(&Context{
		SetRunRecovery: func(config *types.RunRecoveryConfig) { got = config },
	})

	enabled := true
	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{
			"enabled":     enabled,
			"maxAttempts": 5,
		},
	})
	h.handleSetRunRecovery(h.ctxStack.Current(), 1, raw)

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, _ := resp["result"].(map[string]interface{})
	if ok, _ := result["ok"].(bool); !ok {
		t.Errorf("result.ok = %v, want true", result)
	}
	if got == nil {
		t.Fatal("SetRunRecovery was not called")
	}
	if got.Enabled == nil || !*got.Enabled {
		t.Error("expected enabled=true")
	}
	if got.MaxAttempts != 5 {
		t.Errorf("MaxAttempts = %d, want 5", got.MaxAttempts)
	}
}

func TestHandleSetRunRecovery_Disable(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	var got *types.RunRecoveryConfig
	h.ctxStack.Push(&Context{
		SetRunRecovery: func(config *types.RunRecoveryConfig) { got = config },
	})

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"enabled": false},
	})
	h.handleSetRunRecovery(h.ctxStack.Current(), 2, raw)

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	if got == nil {
		t.Fatal("SetRunRecovery was not called")
	}
	if got.Enabled == nil || *got.Enabled {
		t.Error("expected enabled=false")
	}
}

func TestHandleSetRunRecovery_MissingEnabled(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	h.ctxStack.Push(&Context{
		SetRunRecovery: func(_ *types.RunRecoveryConfig) { t.Fatal("should not be called") },
	})

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"maxAttempts": 3},
	})
	h.handleSetRunRecovery(h.ctxStack.Current(), 3, raw)

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32602 {
		t.Errorf("error code = %v, want -32602", errObj)
	}
}

func TestHandleSetRunRecovery_ParseError(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	h.ctxStack.Push(&Context{
		SetRunRecovery: func(_ *types.RunRecoveryConfig) { t.Fatal("should not be called") },
	})

	h.handleSetRunRecovery(h.ctxStack.Current(), 4, []byte(`{not json`))

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32602 {
		t.Errorf("error code = %v, want -32602", errObj)
	}
}

func TestHandleSetRunRecovery_NoCtx(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"enabled": true},
	})
	h.handleSetRunRecovery(nil, 5, raw)

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32603 {
		t.Errorf("error code = %v, want -32603", errObj)
	}
}

func TestHandleSetRunRecovery_NilSetRunRecoveryField(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)

	h.ctxStack.Push(&Context{})

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{"enabled": true},
	})
	h.handleSetRunRecovery(h.ctxStack.Current(), 6, raw)

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32603 {
		t.Errorf("error code = %v, want -32603", errObj)
	}
}

func TestHandleSetRunRecovery_RejectsUnsupportedFields(t *testing.T) {
	t.Parallel()

	h := NewHost()
	ch := attachStdout(h)
	h.ctxStack.Push(&Context{SetRunRecovery: func(_ *types.RunRecoveryConfig) {
		t.Fatal("unsupported fields must not reach context")
	}})

	raw := []byte(`{"params":{"enabled":true,"journalDir":"/tmp/journals"}}`)
	h.handleSetRunRecovery(h.ctxStack.Current(), 7, raw)

	resp := readResponse(t, ch, time.Second)
	errObj, _ := resp["error"].(map[string]interface{})
	if code, _ := errObj["code"].(float64); int(code) != -32602 {
		t.Errorf("error code = %v, want -32602", errObj)
	}
}
