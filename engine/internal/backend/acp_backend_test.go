package backend

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/types"
)

// fakeAcpAgent is a scripted ACP agent over pipes. session/prompt responses are
// deferred until completePrompt is called, so a test can stream session/update
// notifications while the prompt is in flight.
type fakeAcpAgent struct {
	toClient   *io.PipeWriter
	fromClient *bufio.Reader
	writeMu    sync.Mutex

	mu       sync.Mutex
	seen     map[string]json.RawMessage
	promptID json.RawMessage
}

func (a *fakeAcpAgent) serve() {
	for {
		line, err := a.fromClient.ReadBytes('\n')
		if len(line) > 0 {
			var f struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(line, &f) == nil && f.Method != "" {
				a.mu.Lock()
				a.seen[f.Method] = f.Params
				a.mu.Unlock()
				a.handle(f.ID, f.Method)
			}
		}
		if err != nil {
			return
		}
	}
}

func (a *fakeAcpAgent) handle(id json.RawMessage, method string) {
	if len(id) == 0 {
		return // notification
	}
	switch method {
	case acp.MethodInitialize:
		a.reply(id, acp.InitializeResult{ProtocolVersion: 1, AgentCapabilities: acp.AgentCapabilities{LoadSession: true}, AuthMethods: []acp.AuthMethod{{ID: "cached_token", Name: "Cached"}}})
	case acp.MethodSessionNew:
		a.reply(id, acp.SessionResult{SessionID: "sess_1"})
	case acp.MethodSessionPrompt:
		// Defer the response so the test can stream updates first.
		a.mu.Lock()
		a.promptID = append(json.RawMessage(nil), id...)
		a.mu.Unlock()
	default:
		a.reply(id, map[string]any{})
	}
}

func (a *fakeAcpAgent) completePrompt(stopReason string) {
	a.mu.Lock()
	id := a.promptID
	a.mu.Unlock()
	if id == nil {
		return
	}
	a.reply(id, acp.SessionPromptResult{StopReason: stopReason})
}

func (a *fakeAcpAgent) reply(id json.RawMessage, result any) {
	a.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (a *fakeAcpAgent) write(v any) {
	data, _ := json.Marshal(v)
	data = append(data, '\n')
	a.writeMu.Lock()
	_, _ = a.toClient.Write(data)
	a.writeMu.Unlock()
}

func (a *fakeAcpAgent) update(u acp.SessionUpdate) {
	a.write(map[string]any{"jsonrpc": "2.0", "method": acp.NotifSessionUpdate, "params": acp.SessionUpdateNotification{SessionID: "sess_1", Update: u}})
}

func (a *fakeAcpAgent) request(id, method string, params any) {
	a.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": params})
}

func (a *fakeAcpAgent) sawMethod(method string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.seen[method]
	return ok
}

func newTestAcpBackend(t *testing.T) (*AcpBackend, chan *fakeAcpAgent) {
	t.Helper()
	b := NewGrokBackend()
	agentCh := make(chan *fakeAcpAgent, 1)
	b.launch = func(_ acpSpec, h acp.Handlers) (*acp.Client, func(), error) {
		inR, inW := io.Pipe()
		outR, outW := io.Pipe()
		agent := &fakeAcpAgent{toClient: outW, fromClient: bufio.NewReader(inR), seen: map[string]json.RawMessage{}}
		client := acp.NewClient(inW, outR, "grok", h)
		go agent.serve()
		agentCh <- agent
		return client, func() { _ = inW.Close(); _ = outW.Close() }, nil
	}
	t.Cleanup(func() {
		b.mu.Lock()
		k := b.kill
		b.mu.Unlock()
		if k != nil {
			k()
		}
	})
	return b, agentCh
}

func startAcp(t *testing.T, b *AcpBackend, agentCh chan *fakeAcpAgent, req string, opts types.RunOptions) *fakeAcpAgent {
	t.Helper()
	b.StartRun(req, opts)
	select {
	case a := <-agentCh:
		return a
	case <-time.After(2 * time.Second):
		t.Fatal("launcher never fired")
		return nil
	}
}

// ---------------------------------------------------------------------------

func TestGrokSpec(t *testing.T) {
	b := NewGrokBackend()
	if b.spec.binary != "grok" {
		t.Errorf("expected binary grok, got %q", b.spec.binary)
	}
	if len(b.spec.args) != 2 || b.spec.args[0] != "agent" || b.spec.args[1] != "stdio" {
		t.Errorf("expected args [agent stdio], got %v", b.spec.args)
	}
	found := false
	for _, e := range b.spec.envExtra {
		if e == "GROK_OAUTH2_REFERRER=ion" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected GROK_OAUTH2_REFERRER=ion in env, got %v", b.spec.envExtra)
	}
}

func TestGrokAuthMethodFlip(t *testing.T) {
	t.Setenv("XAI_API_KEY", "")
	if got := grokAuthMethodID(); got != "cached_token" {
		t.Errorf("expected cached_token without key, got %q", got)
	}
	t.Setenv("XAI_API_KEY", "xai-123")
	if got := grokAuthMethodID(); got != "xai.api_key" {
		t.Errorf("expected xai.api_key with key, got %q", got)
	}
}

func TestCursorSpec(t *testing.T) {
	b := NewCursorBackend()
	if b.spec.binary != "agent" {
		t.Errorf("expected binary agent, got %q", b.spec.binary)
	}
	if len(b.spec.args) != 1 || b.spec.args[0] != "acp" {
		t.Errorf("expected args [acp], got %v", b.spec.args)
	}
	if b.spec.authMethodID() != "cursor_login" {
		t.Errorf("expected cursor_login, got %q", b.spec.authMethodID())
	}
}

func TestAcpBackend_PlanModeRejected(t *testing.T) {
	b := NewGrokBackend()
	launched := false
	b.launch = func(acpSpec, acp.Handlers) (*acp.Client, func(), error) { launched = true; return nil, nil, nil }
	r := newAcpRecorder()
	r.attach(b)
	b.StartRun("req-plan", types.RunOptions{Model: "grok-code", PlanMode: true})
	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "plan-mode exit")
	if launched {
		t.Fatal("plan mode must not spawn the agent")
	}
}

func TestAcpBackend_HappyPath(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "hi", ProjectPath: "/repo"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionPrompt) }, "session/prompt")

	agent.update(acp.SessionUpdate{SessionUpdate: acp.UpdateAgentMessageChunk, Content: &acp.ContentBlock{Type: "text", Text: "hello"}})
	agent.completePrompt("end_turn")

	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "exit")
	if r.count(isType("session_init")) != 1 {
		t.Errorf("expected 1 session_init, got %d", r.count(isType("session_init")))
	}
	if r.count(isType("text_chunk")) != 1 {
		t.Errorf("expected 1 text_chunk, got %d", r.count(isType("text_chunk")))
	}
	if r.count(isType("task_complete")) != 1 {
		t.Errorf("expected 1 task_complete, got %d", r.count(isType("task_complete")))
	}
	if r.lastExitSession() != "sess_1" {
		t.Errorf("expected exit session sess_1, got %q", r.lastExitSession())
	}
}

func TestAcpBackend_ThoughtToThinking(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "hi"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionPrompt) }, "session/prompt")

	agent.update(acp.SessionUpdate{SessionUpdate: acp.UpdateAgentThoughtChunk, Content: &acp.ContentBlock{Type: "text", Text: "thinking"}})
	agent.update(acp.SessionUpdate{SessionUpdate: acp.UpdateAgentMessageChunk, Content: &acp.ContentBlock{Type: "text", Text: "answer"}})
	agent.completePrompt("end_turn")

	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "exit")
	if r.count(isType("thinking_block_start")) != 1 {
		t.Errorf("expected 1 thinking_block_start, got %d", r.count(isType("thinking_block_start")))
	}
	if r.count(isType("thinking_delta")) != 1 {
		t.Errorf("expected 1 thinking_delta, got %d", r.count(isType("thinking_delta")))
	}
	if r.count(isType("thinking_block_end")) < 1 {
		t.Errorf("expected thinking_block_end, got %d", r.count(isType("thinking_block_end")))
	}
}

func TestAcpBackend_ToolTranslation(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "ls"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionPrompt) }, "session/prompt")

	agent.update(acp.SessionUpdate{SessionUpdate: acp.UpdateToolCall, ToolCallID: "tc_1", Title: "run ls", Kind: "execute", Status: "in_progress"})
	agent.update(acp.SessionUpdate{SessionUpdate: acp.UpdateToolCallUpdate, ToolCallID: "tc_1", Status: "completed"})
	agent.completePrompt("end_turn")

	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "exit")
	if r.count(isType("tool_call")) != 1 {
		t.Errorf("expected 1 tool_call, got %d", r.count(isType("tool_call")))
	}
	if r.count(isType("tool_result")) != 1 {
		t.Errorf("expected 1 tool_result, got %d", r.count(isType("tool_result")))
	}
}

func TestAcpBackend_PermissionRoundTrip(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)
	b.SetPermissionAskCallback(func(_ string, _ string, _ string, _ string, _ map[string]any, opts []types.PermissionOpt) chan string {
		ch := make(chan string, 1)
		ch <- opts[0].ID // choose the first (allow) option
		return ch
	})

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "rm"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionPrompt) }, "session/prompt")

	agent.request("77", acp.ReqRequestPermission, acp.RequestPermissionParams{
		SessionID: "sess_1",
		ToolCall:  acp.ToolCallRef{ToolCallID: "tc_1", Title: "rm", Kind: "execute"},
		Options:   []acp.PermissionOption{{OptionID: "allow_1", Name: "Allow", Kind: "allow_once"}, {OptionID: "deny_1", Name: "Deny", Kind: "reject_once"}},
	})
	agent.completePrompt("end_turn")
	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "exit after permission")
}

func TestAcpBackend_Cancel(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "hi"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionPrompt) }, "session/prompt")
	if !b.Cancel("req-1") {
		t.Fatal("Cancel returned false for active run")
	}
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionCancel) }, "session/cancel")
	agent.completePrompt("cancelled")
	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "exit after cancel")
}

func TestAcpBackend_ResumeUsesLoad(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "hi", CliResumeSessionID: "sess_prev"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionLoad) }, "session/load")
	agent.completePrompt("end_turn")
}

func TestAcpBackend_ProcessDeath(t *testing.T) {
	b, agentCh := newTestAcpBackend(t)
	r := newAcpRecorder()
	r.attach(b)

	agent := startAcp(t, b, agentCh, "req-1", types.RunOptions{Model: "grok-code", Prompt: "hi"})
	acpWaitFor(t, func() bool { return agent.sawMethod(acp.MethodSessionPrompt) }, "session/prompt")
	_ = agent.toClient.Close()
	acpWaitFor(t, func() bool { return r.exitCount() == 1 }, "exit on death")
}

// --- recorder (local to avoid coupling to the codex test's *CodexBackend) ---

type acpRecorder struct {
	mu     sync.Mutex
	events []types.NormalizedEvent
	exits  []string
	errs   []string
}

func newAcpRecorder() *acpRecorder { return &acpRecorder{} }

func (r *acpRecorder) attach(b *AcpBackend) {
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		r.mu.Lock()
		r.events = append(r.events, ev)
		r.mu.Unlock()
	})
	b.OnExit(func(_ string, _ *int, _ *string, sessionID string) {
		r.mu.Lock()
		r.exits = append(r.exits, sessionID)
		r.mu.Unlock()
	})
	b.OnError(func(_ string, err error) {
		r.mu.Lock()
		r.errs = append(r.errs, err.Error())
		r.mu.Unlock()
	})
}

func (r *acpRecorder) count(match func(types.NormalizedEvent) bool) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if match(e) {
			n++
		}
	}
	return n
}

func (r *acpRecorder) exitCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.exits)
}

func (r *acpRecorder) lastExitSession() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.exits) == 0 {
		return ""
	}
	return r.exits[len(r.exits)-1]
}

func acpWaitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", msg)
}
