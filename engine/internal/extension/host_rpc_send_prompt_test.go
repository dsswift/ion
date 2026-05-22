package extension

import (
	"bufio"
	"encoding/json"
	"io"
	"testing"
	"time"
)

// attachStdout wires a pipe to h.stdin so sendResponse writes are captured.
// Returns a channel that receives one complete NDJSON line per response frame.
// The goroutine exits when the pipe's write end is closed.
func attachStdout(h *Host) <-chan []byte {
	pr, pw := io.Pipe()
	h.pendMu.Lock()
	h.stdin = pw
	h.pendMu.Unlock()

	ch := make(chan []byte, 16)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			line := make([]byte, len(sc.Bytes()))
			copy(line, sc.Bytes())
			ch <- line
		}
	}()
	return ch
}

// readResponse reads one JSON-RPC response frame from ch, blocking up to
// timeout. Returns the parsed object or fails the test.
func readResponse(t *testing.T, ch <-chan []byte, timeout time.Duration) map[string]interface{} {
	t.Helper()
	select {
	case line, ok := <-ch:
		if !ok {
			t.Fatal("response channel closed before a frame arrived")
		}
		var out map[string]interface{}
		if err := json.Unmarshal(line, &out); err != nil {
			t.Fatalf("failed to parse response JSON: %v — raw: %s", err, line)
		}
		return out
	case <-time.After(timeout):
		t.Fatalf("no response frame within %s", timeout)
		return nil
	}
}

func sendPromptPayload(t *testing.T, text string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/send_prompt",
		"params":  map[string]string{"text": text},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtSendPrompt_FallsBackToOnSendMessage_WhenNoHookCtx verifies the timer/scheduler
// path: no active hook dispatch ctx, but onSendMessage (wired by the session manager)
// is available and should be called. Asserts the {"ok":true} response envelope.
func TestExtSendPrompt_FallsBackToOnSendMessage_WhenNoHookCtx(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	// currentCtx is nil by default -- simulates a timer-fired call with no active hook.

	called := make(chan string, 1)
	h.SetOnSendMessage(func(text string) {
		called <- text
	})

	h.handleExtRequest("ext/send_prompt", 1, sendPromptPayload(t, "Deliver the morning brief now."))

	select {
	case got := <-called:
		if got != "Deliver the morning brief now." {
			t.Fatalf("expected prompt text, got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("onSendMessage was not called within 1s")
	}

	resp := readResponse(t, ch, time.Second)
	if result, ok := resp["result"].(map[string]interface{}); !ok || result["ok"] != true {
		t.Errorf("expected {\"ok\":true} result, got %v", resp)
	}
	if resp["error"] != nil {
		t.Errorf("expected no error, got %v", resp["error"])
	}
}

// TestExtSendPrompt_UsesHookCtx_WhenActive verifies that ext/send_prompt routes
// through ctx.SendPrompt when an active hook dispatch context is present, and does
// not call onSendMessage.
func TestExtSendPrompt_UsesHookCtx_WhenActive(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	hookCalled := make(chan string, 1)
	ctx := &Context{
		Cwd:   "/tmp",
		Model: &ModelRef{ID: "claude-sonnet-4-20250514", ContextWindow: 200000},
		SendPrompt: func(text, _ string) error {
			hookCalled <- text
			return nil
		},
	}
	h.currentCtx.Store(ctx)

	h.SetOnSendMessage(func(_ string) {
		t.Error("onSendMessage must not be called when hook ctx is active")
	})

	h.handleExtRequest("ext/send_prompt", 1, sendPromptPayload(t, "test hook path"))

	select {
	case got := <-hookCalled:
		if got != "test hook path" {
			t.Fatalf("expected 'test hook path', got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("ctx.SendPrompt was not called within 1s")
	}

	resp := readResponse(t, ch, time.Second)
	if result, ok := resp["result"].(map[string]interface{}); !ok || result["ok"] != true {
		t.Errorf("expected {\"ok\":true} result, got %v", resp)
	}
}

// TestExtSendPrompt_ReturnsError_WhenNoSessionAtAll verifies that ext/send_prompt
// returns the correct error envelope when neither hook ctx nor onSendMessage is set.
func TestExtSendPrompt_ReturnsError_WhenNoSessionAtAll(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	// No ctx, no onSendMessage.
	h.handleExtRequest("ext/send_prompt", 1, sendPromptPayload(t, "no session"))

	resp := readResponse(t, ch, time.Second)
	errObj, ok := resp["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error object, got %v", resp)
	}
	if code := errObj["code"]; code != float64(-32000) {
		t.Errorf("expected code -32000, got %v", code)
	}
	if msg, _ := errObj["message"].(string); msg != "sendPrompt not available: no active session" {
		t.Errorf("unexpected error message: %q", msg)
	}
}

// TestExtSendPrompt_RejectsEmptyText verifies that an empty prompt is rejected
// before either path is attempted, returning a -32602 error envelope.
func TestExtSendPrompt_RejectsEmptyText(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.SetOnSendMessage(func(_ string) {
		t.Error("onSendMessage must not be called for empty prompt")
	})

	data, _ := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/send_prompt",
		"params":  map[string]string{"text": ""},
	})
	h.handleExtRequest("ext/send_prompt", 1, data)

	resp := readResponse(t, ch, time.Second)
	errObj, ok := resp["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error object, got %v", resp)
	}
	if code := errObj["code"]; code != float64(-32602) {
		t.Errorf("expected code -32602, got %v", code)
	}
	if msg, _ := errObj["message"].(string); msg != "prompt text required" {
		t.Errorf("unexpected error message: %q", msg)
	}
}
