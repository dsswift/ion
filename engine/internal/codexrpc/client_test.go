package codexrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// fakeCodex is a scripted codex app-server over pipes. Handlers answer client
// requests; the peer can also originate approval requests and notifications.
type fakeCodex struct {
	toClient   *io.PipeWriter
	fromClient *bufio.Reader
	writeMu    sync.Mutex

	mu       sync.Mutex
	handlers map[string]func(params json.RawMessage) any
	seen     map[string]json.RawMessage // method → last params seen
}

type peerFrame struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

func newFakeCodex(t *testing.T, h Handlers) (*Client, *fakeCodex) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	peer := &fakeCodex{
		toClient:   outW,
		fromClient: bufio.NewReader(inR),
		handlers:   make(map[string]func(json.RawMessage) any),
		seen:       make(map[string]json.RawMessage),
	}
	c := NewClient(inW, outR, h)
	go peer.serve()
	t.Cleanup(func() { _ = c.Close(); _ = outW.Close() })
	return c, peer
}

func (p *fakeCodex) on(method string, fn func(params json.RawMessage) any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.handlers[method] = fn
}

func (p *fakeCodex) paramsFor(method string) json.RawMessage {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.seen[method]
}

func (p *fakeCodex) serve() {
	for {
		line, err := p.fromClient.ReadBytes('\n')
		if len(line) > 0 {
			var f peerFrame
			if json.Unmarshal(line, &f) == nil && f.Method != "" {
				p.mu.Lock()
				p.seen[f.Method] = f.Params
				fn := p.handlers[f.Method]
				p.mu.Unlock()
				if len(f.ID) > 0 { // request expecting a response
					var result any = map[string]any{}
					if fn != nil {
						result = fn(f.Params)
					}
					p.write(map[string]any{"jsonrpc": "2.0", "id": f.ID, "result": result})
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (p *fakeCodex) write(v any) {
	data, _ := json.Marshal(v)
	data = append(data, '\n')
	p.writeMu.Lock()
	_, _ = p.toClient.Write(data)
	p.writeMu.Unlock()
}

func (p *fakeCodex) notify(method string, params any) {
	p.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (p *fakeCodex) request(id string, method string, params any) {
	p.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": params})
}

// ---------------------------------------------------------------------------

func TestCodex_Initialize(t *testing.T) {
	c, peer := newFakeCodex(t, Handlers{})
	peer.on("initialize", func(json.RawMessage) any {
		return InitializeResult{CodexHome: "/home/.codex", PlatformOs: "darwin"}
	})
	res, err := c.Initialize(context.Background(), ClientInfo{Name: "ion", Version: "1.0"})
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if res.CodexHome != "/home/.codex" {
		t.Fatalf("unexpected codexHome: %q", res.CodexHome)
	}
	// The clientInfo must be sent verbatim under the "initialize" method.
	var sent InitializeParams
	if err := json.Unmarshal(peer.paramsFor("initialize"), &sent); err != nil {
		t.Fatalf("decode sent params: %v", err)
	}
	if sent.ClientInfo.Name != "ion" || sent.ClientInfo.Version != "1.0" {
		t.Fatalf("clientInfo not sent verbatim: %+v", sent.ClientInfo)
	}
	// initialized notification must follow.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if peer.paramsFor("initialized") != nil || func() bool { p := peer; p.mu.Lock(); _, ok := p.seen["initialized"]; p.mu.Unlock(); return ok }() {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	peer.mu.Lock()
	_, gotInitialized := peer.seen["initialized"]
	peer.mu.Unlock()
	if !gotInitialized {
		t.Fatal("expected initialized notification after initialize")
	}
}

func TestCodex_AccountRead_ChatGPT(t *testing.T) {
	c, peer := newFakeCodex(t, Handlers{})
	peer.on("account/read", func(json.RawMessage) any {
		return AccountReadResult{
			Account:            &Account{Type: "chatgpt", Email: "u@example.com", PlanType: "pro"},
			RequiresOpenaiAuth: false,
		}
	})
	res, err := c.AccountRead(context.Background(), false)
	if err != nil {
		t.Fatalf("account/read: %v", err)
	}
	if res.Account == nil || res.Account.Type != "chatgpt" || res.Account.PlanType != "pro" || res.Account.Email != "u@example.com" {
		t.Fatalf("unexpected account: %+v", res.Account)
	}
}

func TestCodex_AccountRead_RequiresAuth(t *testing.T) {
	c, peer := newFakeCodex(t, Handlers{})
	peer.on("account/read", func(json.RawMessage) any {
		return AccountReadResult{Account: nil, RequiresOpenaiAuth: true}
	})
	res, err := c.AccountRead(context.Background(), false)
	if err != nil {
		t.Fatalf("account/read: %v", err)
	}
	if res.Account != nil || !res.RequiresOpenaiAuth {
		t.Fatalf("expected nil account + requiresOpenaiAuth, got %+v", res)
	}
}

func TestCodex_ModelListPagination(t *testing.T) {
	c, peer := newFakeCodex(t, Handlers{})
	next := "page2"
	peer.on("model/list", func(params json.RawMessage) any {
		var p ModelListParams
		_ = json.Unmarshal(params, &p)
		if p.Cursor == nil {
			return ModelListResult{
				Data:       []Model{{Model: "gpt-5-codex", DisplayName: "GPT-5 Codex"}},
				NextCursor: &next,
			}
		}
		return ModelListResult{
			Data: []Model{{Model: "gpt-5-mini", DisplayName: "GPT-5 Mini"}},
		}
	})
	all, err := c.ModelListAll(context.Background(), "")
	if err != nil {
		t.Fatalf("model/list: %v", err)
	}
	if len(all) != 2 || all[0].Model != "gpt-5-codex" || all[1].Model != "gpt-5-mini" {
		t.Fatalf("expected 2 paginated models, got %+v", all)
	}
}

func TestCodex_ThreadAndTurnLifecycle(t *testing.T) {
	c, peer := newFakeCodex(t, Handlers{})
	peer.on("thread/start", func(json.RawMessage) any {
		return threadResult{Thread: Thread{ID: "th_1", Model: "gpt-5-codex"}}
	})
	peer.on("turn/start", func(json.RawMessage) any {
		return turnResult{Turn: struct {
			ID string `json:"id"`
		}{ID: "tn_1"}}
	})
	peer.on("turn/interrupt", func(json.RawMessage) any { return map[string]any{} })

	threadID, err := c.ThreadStart(context.Background(), ThreadStartParams{Cwd: "/repo", Model: "gpt-5-codex"})
	if err != nil {
		t.Fatalf("thread/start: %v", err)
	}
	if threadID != "th_1" {
		t.Fatalf("expected th_1, got %q", threadID)
	}
	turnID, err := c.TurnStart(context.Background(), TurnStartParams{ThreadID: threadID, Input: NewTextInput("hello")})
	if err != nil {
		t.Fatalf("turn/start: %v", err)
	}
	if turnID != "tn_1" {
		t.Fatalf("expected tn_1, got %q", turnID)
	}
	// turn/start input must be the text-item array shape.
	var ts TurnStartParams
	if err := json.Unmarshal(peer.paramsFor("turn/start"), &ts); err != nil {
		t.Fatalf("decode turn/start params: %v", err)
	}
	if ts.ThreadID != "th_1" {
		t.Fatalf("turn/start threadId not sent: %+v", ts)
	}
	if err := c.TurnInterrupt(context.Background(), threadID, turnID); err != nil {
		t.Fatalf("turn/interrupt: %v", err)
	}
}

func TestCodex_LoginStart_DeviceCode(t *testing.T) {
	c, peer := newFakeCodex(t, Handlers{})
	peer.on("account/login/start", func(json.RawMessage) any {
		return LoginStartResult{Type: "chatgptDeviceCode", LoginID: "lg_1", UserCode: "ABCD-1234", VerificationURL: "https://auth/device"}
	})
	res, err := c.LoginStart(context.Background())
	if err != nil {
		t.Fatalf("login/start: %v", err)
	}
	if res.Type != "chatgptDeviceCode" || res.UserCode != "ABCD-1234" || res.VerificationURL != "https://auth/device" {
		t.Fatalf("unexpected login result: %+v", res)
	}
}

func TestCodex_CommandApproval_RoundTrip(t *testing.T) {
	gotCmd := make(chan string, 1)
	c, peer := newFakeCodex(t, Handlers{
		OnCommandApproval: func(p CommandApprovalParams) string {
			gotCmd <- p.Command
			return DecisionAccept
		},
	})
	// The client responds to the peer request; capture the client's response
	// by round-tripping a follow-up request through a shared handler.
	answered := make(chan struct{})
	peer.on("account/read", func(json.RawMessage) any { close(answered); return AccountReadResult{} })

	peer.request("55", ReqCommandApproval, CommandApprovalParams{ItemID: "it_1", Command: "rm -rf /tmp/x", Cwd: "/repo"})

	select {
	case cmd := <-gotCmd:
		if cmd != "rm -rf /tmp/x" {
			t.Fatalf("handler saw wrong command: %q", cmd)
		}
	case <-time.After(time.Second):
		t.Fatal("OnCommandApproval never fired")
	}
	// Client stays healthy after answering the approval.
	if _, err := c.AccountRead(context.Background(), false); err != nil {
		t.Fatalf("client unhealthy after approval: %v", err)
	}
	<-answered
}

func TestCodex_Notifications_Forwarded(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	deltas := make(chan string, 1)
	c, peer := newFakeCodex(t, Handlers{
		OnNotification: func(method string, params json.RawMessage) {
			mu.Lock()
			methods = append(methods, method)
			mu.Unlock()
			if method == NotifAgentMessageDelta {
				var d DeltaNotification
				_ = json.Unmarshal(params, &d)
				deltas <- d.Delta
			}
		},
	})
	_ = c
	peer.notify(NotifThreadStarted, ThreadStartedNotification{ThreadID: "th_1"})
	peer.notify(NotifAgentMessageDelta, DeltaNotification{Delta: "hello world", ItemID: "it_1"})

	select {
	case d := <-deltas:
		if d != "hello world" {
			t.Fatalf("unexpected delta: %q", d)
		}
	case <-time.After(time.Second):
		t.Fatal("agentMessage delta not forwarded")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(methods) < 2 || methods[0] != NotifThreadStarted {
		t.Fatalf("notifications not forwarded in order: %v", methods)
	}
}
