package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// fakeAgent is a scripted ACP agent over pipes.
type fakeAgent struct {
	toClient   *io.PipeWriter
	fromClient *bufio.Reader
	writeMu    sync.Mutex

	mu       sync.Mutex
	handlers map[string]func(json.RawMessage) any
	seen     map[string]json.RawMessage
}

func newFakeAgent(t *testing.T, tag string, h Handlers) (*Client, *fakeAgent) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	agent := &fakeAgent{
		toClient:   outW,
		fromClient: bufio.NewReader(inR),
		handlers:   make(map[string]func(json.RawMessage) any),
		seen:       make(map[string]json.RawMessage),
	}
	c := NewClient(inW, outR, tag, h)
	go agent.serve()
	t.Cleanup(func() { _ = c.Close(); _ = outW.Close() })
	return c, agent
}

func (a *fakeAgent) on(method string, fn func(json.RawMessage) any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.handlers[method] = fn
}

func (a *fakeAgent) paramsFor(method string) json.RawMessage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.seen[method]
}

func (a *fakeAgent) serve() {
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
				fn := a.handlers[f.Method]
				a.mu.Unlock()
				if len(f.ID) > 0 {
					var result any = map[string]any{}
					if fn != nil {
						result = fn(f.Params)
					}
					a.write(map[string]any{"jsonrpc": "2.0", "id": f.ID, "result": result})
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (a *fakeAgent) write(v any) {
	data, _ := json.Marshal(v)
	data = append(data, '\n')
	a.writeMu.Lock()
	_, _ = a.toClient.Write(data)
	a.writeMu.Unlock()
}

func (a *fakeAgent) notify(method string, params any) {
	a.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (a *fakeAgent) request(id, method string, params any) {
	a.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": params})
}

// ---------------------------------------------------------------------------

func TestACP_Initialize(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{})
	agent.on("initialize", func(json.RawMessage) any {
		return InitializeResult{
			ProtocolVersion:   1,
			AgentCapabilities: AgentCapabilities{LoadSession: true},
			AuthMethods:       []AuthMethod{{ID: "xai.api_key", Name: "API Key"}, {ID: "cached_token", Name: "Cached"}},
		}
	})
	res, err := c.Initialize(context.Background(), ClientInfo{Name: "ion", Version: "1"})
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if !res.AgentCapabilities.LoadSession || len(res.AuthMethods) != 2 || res.AuthMethods[0].ID != "xai.api_key" {
		t.Fatalf("unexpected init result: %+v", res)
	}
	var sent InitializeParams
	_ = json.Unmarshal(agent.paramsFor("initialize"), &sent)
	if sent.ProtocolVersion != 1 {
		t.Fatalf("expected protocolVersion 1, got %d", sent.ProtocolVersion)
	}
}

func TestACP_Authenticate(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{})
	agent.on("authenticate", func(json.RawMessage) any { return map[string]any{} })
	if err := c.Authenticate(context.Background(), "cursor_login"); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	var sent AuthenticateParams
	_ = json.Unmarshal(agent.paramsFor("authenticate"), &sent)
	if sent.MethodID != "cursor_login" {
		t.Fatalf("expected methodId cursor_login, got %q", sent.MethodID)
	}
}

func TestACP_SessionNew_WithModels(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{})
	agent.on("session/new", func(json.RawMessage) any {
		return SessionResult{
			SessionID: "sess_1",
			Models: &ModelState{
				CurrentModelID:  "grok-code",
				AvailableModels: []ModelInfo{{ModelID: "grok-code", Name: "Grok Code"}, {ModelID: "grok-4", Name: "Grok 4"}},
			},
		}
	})
	res, err := c.SessionNew(context.Background(), "/repo")
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	if res.SessionID != "sess_1" || res.Models == nil || len(res.Models.AvailableModels) != 2 {
		t.Fatalf("unexpected session result: %+v", res)
	}

	// Regression: grok's ACP rejects session/new with -32602 when mcpServers
	// is absent. The field must serialize as `[]` (present, empty), never be
	// omitted. Assert the wire payload the agent actually received.
	raw := agent.paramsFor("session/new")
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode session/new params: %v", err)
	}
	mcp, present := got["mcpServers"]
	if !present {
		t.Fatalf("session/new params missing mcpServers (grok rejects this): %s", raw)
	}
	if string(mcp) != "[]" {
		t.Fatalf("mcpServers = %s, want [] (present, empty array)", mcp)
	}
}

// TestACP_SessionLoad_SendsMcpServers pins the same required-field contract on
// session/load: mcpServers must be present as `[]`, not omitted.
func TestACP_SessionLoad_SendsMcpServers(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{})
	agent.on("session/load", func(json.RawMessage) any {
		return SessionResult{SessionID: "sess_9"}
	})
	if _, err := c.SessionLoad(context.Background(), "sess_9", "/repo"); err != nil {
		t.Fatalf("session/load: %v", err)
	}
	raw := agent.paramsFor("session/load")
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode session/load params: %v", err)
	}
	if mcp, present := got["mcpServers"]; !present || string(mcp) != "[]" {
		t.Fatalf("session/load mcpServers = %s (present=%v), want [] present", mcp, present)
	}
}

func TestACP_Prompt_StopReason(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{})
	agent.on("session/prompt", func(json.RawMessage) any {
		return SessionPromptResult{StopReason: "end_turn"}
	})
	res, err := c.SessionPrompt(context.Background(), "sess_1", NewTextPrompt("hi"))
	if err != nil {
		t.Fatalf("session/prompt: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("expected end_turn, got %q", res.StopReason)
	}
	var sent SessionPromptParams
	_ = json.Unmarshal(agent.paramsFor("session/prompt"), &sent)
	if len(sent.Prompt) != 1 || sent.Prompt[0].Type != "text" || sent.Prompt[0].Text != "hi" {
		t.Fatalf("prompt content not sent as text block: %+v", sent.Prompt)
	}
}

func TestACP_CursorListModels(t *testing.T) {
	c, agent := newFakeAgent(t, "cursor", Handlers{})
	agent.on("cursor/list_available_models", func(json.RawMessage) any {
		return CursorListModelsResult{Models: []CursorModel{{Value: "gpt-5", Name: "GPT-5"}, {Value: "sonnet", Name: "Sonnet"}}}
	})
	res, err := c.CursorListModels(context.Background())
	if err != nil {
		t.Fatalf("cursor/list_available_models: %v", err)
	}
	if len(res.Models) != 2 || res.Models[0].Value != "gpt-5" {
		t.Fatalf("unexpected cursor models: %+v", res.Models)
	}
}

func TestACP_SessionUpdate_Forwarded(t *testing.T) {
	updates := make(chan SessionUpdate, 4)
	c, agent := newFakeAgent(t, "grok", Handlers{
		OnSessionUpdate: func(n SessionUpdateNotification) { updates <- n.Update },
	})
	_ = c
	agent.notify(NotifSessionUpdate, SessionUpdateNotification{
		SessionID: "sess_1",
		Update:    SessionUpdate{SessionUpdate: UpdateAgentMessageChunk, Content: &ContentBlock{Type: "text", Text: "hello"}},
	})
	select {
	case u := <-updates:
		if u.SessionUpdate != UpdateAgentMessageChunk || u.Content == nil || u.Content.Text != "hello" {
			t.Fatalf("unexpected update: %+v", u)
		}
	case <-time.After(time.Second):
		t.Fatal("session/update not forwarded")
	}
}

func TestACP_RequestPermission_RoundTrip(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{
		OnPermission: func(p RequestPermissionParams) PermissionOutcome {
			// Choose the first allow option.
			for _, o := range p.Options {
				if o.Kind == "allow_once" {
					return PermissionOutcome{Outcome: OutcomeSelected, OptionID: o.OptionID}
				}
			}
			return PermissionOutcome{Outcome: OutcomeCancelled}
		},
	})
	answered := make(chan struct{})
	agent.on("session/prompt", func(json.RawMessage) any { close(answered); return SessionPromptResult{StopReason: "end_turn"} })

	agent.request("3", ReqRequestPermission, RequestPermissionParams{
		SessionID: "sess_1",
		ToolCall:  ToolCallRef{ToolCallID: "tc_1", Title: "run ls", Kind: "execute"},
		Options: []PermissionOption{
			{OptionID: "opt_allow", Name: "Allow", Kind: "allow_once"},
			{OptionID: "opt_deny", Name: "Deny", Kind: "reject_once"},
		},
	})
	// Confirm the client stays healthy after answering the permission.
	if _, err := c.SessionPrompt(context.Background(), "sess_1", NewTextPrompt("go")); err != nil {
		t.Fatalf("client unhealthy after permission: %v", err)
	}
	<-answered
}

func TestACP_Cancel_Notification(t *testing.T) {
	c, agent := newFakeAgent(t, "grok", Handlers{})
	if err := c.SessionCancel("sess_1"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if agent.paramsFor("session/cancel") != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	var p SessionCancelParams
	_ = json.Unmarshal(agent.paramsFor("session/cancel"), &p)
	if p.SessionID != "sess_1" {
		t.Fatalf("expected cancel for sess_1, got %q", p.SessionID)
	}
}
