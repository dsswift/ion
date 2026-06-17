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
	// ctxStack is empty by default -- simulates a timer-fired call with no active hook.

	called := make(chan string, 1)
	h.SetOnSendMessage(func(p SendPromptPayload) {
		called <- p.Text
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
		SendPrompt: func(text, _ string, _ []string) error {
			hookCalled <- text
			return nil
		},
	}
	h.ctxStack.Push(ctx)

	h.SetOnSendMessage(func(SendPromptPayload) {
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
	h.SetOnSendMessage(func(SendPromptPayload) {
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

// sendPromptPayloadWithAdditions builds an ext/send_prompt frame carrying
// per-prompt plan-mode bash-allowlist additions, mirroring what the SDK
// runtime sends when a command's frontmatter declares allowed_bash_commands.
func sendPromptPayloadWithAdditions(t *testing.T, text string, additions []string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/send_prompt",
		"params": map[string]interface{}{
			"text":                   text,
			"bashAllowlistAdditions": additions,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// sendPromptPayloadFull builds an ext/send_prompt frame carrying both a model
// override and bash-allowlist additions — the full per-prompt payload. Used by
// the parity test to drive identical input through both dispatch paths.
func sendPromptPayloadFull(t *testing.T, text, model string, additions []string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/send_prompt",
		"params": map[string]interface{}{
			"text":                   text,
			"model":                  model,
			"bashAllowlistAdditions": additions,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtSendPrompt_ThreadsBashAllowlistAdditions_OnHookCtx verifies that the
// ext/send_prompt RPC decodes the bashAllowlistAdditions param and forwards it
// as the third argument to ctx.SendPrompt on the active-hook path. This is the
// wire-decode half of the fix that lets a slash command dispatched as an
// extension command grant itself plan-mode Bash allowances for its own turn.
//
// Revert check: if host_rpc.go drops the param (passes nil), the recorded
// additions slice is empty and this test fails.
func TestExtSendPrompt_ThreadsBashAllowlistAdditions_OnHookCtx(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	type capture struct {
		text      string
		additions []string
	}
	got := make(chan capture, 1)
	ctx := &Context{
		Cwd:   "/tmp",
		Model: &ModelRef{ID: "claude-sonnet-4-20250514", ContextWindow: 200000},
		SendPrompt: func(text, _ string, bashAllowlistAdditions []string) error {
			got <- capture{text: text, additions: bashAllowlistAdditions}
			return nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/send_prompt", 1, sendPromptPayloadWithAdditions(t, "create the issue", []string{"gh issue create", "gh issue view"}))

	select {
	case c := <-got:
		if c.text != "create the issue" {
			t.Fatalf("expected text 'create the issue', got %q", c.text)
		}
		if len(c.additions) != 2 || c.additions[0] != "gh issue create" || c.additions[1] != "gh issue view" {
			t.Fatalf("expected bash additions [gh issue create, gh issue view], got %v", c.additions)
		}
	case <-time.After(time.Second):
		t.Fatal("ctx.SendPrompt was not called within 1s")
	}

	resp := readResponse(t, ch, time.Second)
	if result, ok := resp["result"].(map[string]interface{}); !ok || result["ok"] != true {
		t.Errorf("expected {\"ok\":true} result, got %v", resp)
	}
}

// TestExtSendPrompt_ForwardsBashAllowlistAdditions_OnFallbackPath verifies that
// when there is no active hook ctx (timer/scheduler path), the onSendMessage
// fallback fires with the FULL payload — text AND bash-allowlist additions AND
// model. This is the regression guard for the pipeline-unification fix: the
// fallback path used to drop model + additions (onSendMessage was text-only),
// so a slash command invoked from a background/timer context lost its
// frontmatter bash grants and model hint. Now both paths carry identical payload.
//
// Revert proof: with onSendMessage narrowed back to text-only (dropping the
// SendPromptPayload fields), p.BashAllowlistAdditions / p.Model are empty and
// this test fails.
func TestExtSendPrompt_ForwardsBashAllowlistAdditions_OnFallbackPath(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	// ctxStack empty -> fallback path.

	called := make(chan SendPromptPayload, 1)
	h.SetOnSendMessage(func(p SendPromptPayload) {
		called <- p
	})

	h.handleExtRequest("ext/send_prompt", 1, sendPromptPayloadFull(t, "fallback prompt", "claude-opus-4-20250514", []string{"gh issue create"}))

	select {
	case got := <-called:
		if got.Text != "fallback prompt" {
			t.Fatalf("expected text 'fallback prompt', got %q", got.Text)
		}
		if got.Model != "claude-opus-4-20250514" {
			t.Fatalf("expected model carried on fallback path, got %q", got.Model)
		}
		if len(got.BashAllowlistAdditions) != 1 || got.BashAllowlistAdditions[0] != "gh issue create" {
			t.Fatalf("expected bash additions [gh issue create] carried on fallback path, got %v", got.BashAllowlistAdditions)
		}
	case <-time.After(time.Second):
		t.Fatal("onSendMessage was not called within 1s")
	}

	resp := readResponse(t, ch, time.Second)
	if result, ok := resp["result"].(map[string]interface{}); !ok || result["ok"] != true {
		t.Errorf("expected {\"ok\":true} result, got %v", resp)
	}
}

// TestExtSendPrompt_PayloadParity_AcrossDispatchPaths is the core "one pipeline,
// identical behavior regardless of entry point" guard. It drives the SAME
// ext/send_prompt frame (text + model + bash additions) through both dispatch
// paths — hook-ctx present vs. absent — and asserts the payload that reaches
// the run-config seam is equivalent on both. The hook path receives the values
// as ctx.SendPrompt args; the fallback path receives them as a SendPromptPayload.
// If either path ever drops or reorders a field, the parity assertion fails.
func TestExtSendPrompt_PayloadParity_AcrossDispatchPaths(t *testing.T) {
	const text = "do the unified thing"
	const model = "claude-sonnet-4-20250514"
	additions := []string{"gh issue create", "git diff"}

	// --- Path 1: active hook ctx ---
	hookHost := NewHost()
	hookCh := attachStdout(hookHost)
	type capture struct {
		text      string
		model     string
		additions []string
	}
	hookGot := make(chan capture, 1)
	hookHost.ctxStack.Push(&Context{
		Cwd: "/tmp",
		SendPrompt: func(tx, md string, adds []string) error {
			hookGot <- capture{text: tx, model: md, additions: adds}
			return nil
		},
	})
	hookHost.handleExtRequest("ext/send_prompt", 1, sendPromptPayloadFull(t, text, model, additions))

	var hookCap capture
	select {
	case hookCap = <-hookGot:
	case <-time.After(time.Second):
		t.Fatal("hook path: ctx.SendPrompt not called within 1s")
	}
	readResponse(t, hookCh, time.Second)

	// --- Path 2: no hook ctx -> fallback ---
	fbHost := NewHost()
	fbCh := attachStdout(fbHost)
	fbGot := make(chan SendPromptPayload, 1)
	fbHost.SetOnSendMessage(func(p SendPromptPayload) {
		fbGot <- p
	})
	fbHost.handleExtRequest("ext/send_prompt", 1, sendPromptPayloadFull(t, text, model, additions))

	var fbCap SendPromptPayload
	select {
	case fbCap = <-fbGot:
	case <-time.After(time.Second):
		t.Fatal("fallback path: onSendMessage not called within 1s")
	}
	readResponse(t, fbCh, time.Second)

	// --- Parity assertions ---
	if hookCap.text != fbCap.Text {
		t.Errorf("text diverges: hook=%q fallback=%q", hookCap.text, fbCap.Text)
	}
	if hookCap.model != fbCap.Model {
		t.Errorf("model diverges: hook=%q fallback=%q", hookCap.model, fbCap.Model)
	}
	if len(hookCap.additions) != len(fbCap.BashAllowlistAdditions) {
		t.Fatalf("additions length diverges: hook=%v fallback=%v", hookCap.additions, fbCap.BashAllowlistAdditions)
	}
	for i := range hookCap.additions {
		if hookCap.additions[i] != fbCap.BashAllowlistAdditions[i] {
			t.Errorf("additions[%d] diverges: hook=%q fallback=%q", i, hookCap.additions[i], fbCap.BashAllowlistAdditions[i])
		}
	}
}
