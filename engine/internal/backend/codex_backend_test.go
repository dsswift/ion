package backend

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/types"
)

// fakeCodexPeer is a scripted codex app-server over pipes, used to drive a
// CodexBackend through its launcher seam without spawning a real process.
type fakeCodexPeer struct {
	toClient   *io.PipeWriter
	fromClient *bufio.Reader
	writeMu    sync.Mutex

	mu   sync.Mutex
	seen map[string]json.RawMessage
}

func (p *fakeCodexPeer) serve() {
	for {
		line, err := p.fromClient.ReadBytes('\n')
		if len(line) > 0 {
			var f struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(line, &f) == nil && f.Method != "" {
				p.mu.Lock()
				p.seen[f.Method] = f.Params
				p.mu.Unlock()
				if len(f.ID) > 0 {
					p.write(map[string]any{"jsonrpc": "2.0", "id": f.ID, "result": p.respond(f.Method)})
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (p *fakeCodexPeer) respond(method string) any {
	switch method {
	case codexrpc.MethodInitialize:
		return codexrpc.InitializeResult{CodexHome: "/h", PlatformOs: "darwin"}
	case codexrpc.MethodThreadStart, codexrpc.MethodThreadResume:
		return map[string]any{"thread": map[string]any{"id": "th_test", "model": "gpt-5-codex"}}
	case codexrpc.MethodTurnStart:
		return map[string]any{"turn": map[string]any{"id": "tn_test"}}
	case codexrpc.MethodTurnSteer:
		return map[string]any{"turnId": "tn_test2"}
	default:
		return map[string]any{}
	}
}

func (p *fakeCodexPeer) write(v any) {
	data, _ := json.Marshal(v)
	data = append(data, '\n')
	p.writeMu.Lock()
	_, _ = p.toClient.Write(data)
	p.writeMu.Unlock()
}

func (p *fakeCodexPeer) notify(method string, params any) {
	p.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (p *fakeCodexPeer) request(id, method string, params any) {
	p.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": params})
}

func (p *fakeCodexPeer) sawMethod(method string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.seen[method]
	return ok
}

// recorder captures backend callbacks for assertions.
type recorder struct {
	mu       sync.Mutex
	events   []types.NormalizedEvent
	exits    []string // sessionID per exit
	errs     []string
	exitCode map[string]*int
}

func newRecorder() *recorder { return &recorder{exitCode: map[string]*int{}} }

func (r *recorder) attach(b *CodexBackend) {
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		r.mu.Lock()
		r.events = append(r.events, ev)
		r.mu.Unlock()
	})
	b.OnExit(func(runID string, code *int, _ *string, sessionID string) {
		r.mu.Lock()
		r.exits = append(r.exits, sessionID)
		r.exitCode[runID] = code
		r.mu.Unlock()
	})
	b.OnError(func(_ string, err error) {
		r.mu.Lock()
		r.errs = append(r.errs, err.Error())
		r.mu.Unlock()
	})
}

// count returns the number of captured events matching the predicate.
func (r *recorder) count(match func(types.NormalizedEvent) bool) int {
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

func (r *recorder) exitCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.exits)
}

func waitFor(t *testing.T, cond func() bool, msg string) {
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

// newTestCodexBackend wires a CodexBackend to a fake-peer launcher. The peer is
// delivered on the returned channel when StartRun triggers the lazy launch.
func newTestCodexBackend(t *testing.T) (*CodexBackend, chan *fakeCodexPeer) {
	t.Helper()
	b := NewCodexBackend()
	peerCh := make(chan *fakeCodexPeer, 1)
	b.launch = func(h codexrpc.Handlers) (*codexrpc.Client, func(), error) {
		inR, inW := io.Pipe()
		outR, outW := io.Pipe()
		peer := &fakeCodexPeer{toClient: outW, fromClient: bufio.NewReader(inR), seen: map[string]json.RawMessage{}}
		client := codexrpc.NewClient(inW, outR, h)
		go peer.serve()
		peerCh <- peer
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
	return b, peerCh
}

// startAndPeer starts a run and returns the fake peer once the launcher fires.
func startAndPeer(t *testing.T, b *CodexBackend, peerCh chan *fakeCodexPeer, req string, opts types.RunOptions) *fakeCodexPeer {
	t.Helper()
	b.StartRun(req, opts)
	select {
	case p := <-peerCh:
		return p
	case <-time.After(2 * time.Second):
		t.Fatal("launcher never fired")
		return nil
	}
}

func isType(name string) func(types.NormalizedEvent) bool {
	return func(e types.NormalizedEvent) bool {
		if e.Data == nil {
			return false
		}
		switch e.Data.(type) {
		case *types.SessionInitEvent:
			return name == "session_init"
		case *types.TextChunkEvent:
			return name == "text_chunk"
		case *types.ThinkingBlockStartEvent:
			return name == "thinking_block_start"
		case *types.ThinkingDeltaEvent:
			return name == "thinking_delta"
		case *types.ThinkingBlockEndEvent:
			return name == "thinking_block_end"
		case *types.ToolCallEvent:
			return name == "tool_call"
		case *types.ToolResultEvent:
			return name == "tool_result"
		case *types.UsageEvent:
			return name == "usage"
		case *types.TaskCompleteEvent:
			return name == "task_complete"
		case *types.ErrorEvent:
			return name == "error"
		}
		return false
	}
}

// ---------------------------------------------------------------------------

func TestCodexBackend_PlanModeRejected(t *testing.T) {
	b := NewCodexBackend()
	launched := false
	b.launch = func(codexrpc.Handlers) (*codexrpc.Client, func(), error) {
		launched = true
		return nil, nil, nil
	}
	r := newRecorder()
	r.attach(b)
	b.StartRun("req-plan", types.RunOptions{Model: "gpt-5-codex", PlanMode: true})
	waitFor(t, func() bool { return r.exitCount() == 1 }, "plan-mode exit")
	if launched {
		t.Fatal("plan mode must not spawn the codex process")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.errs) != 1 {
		t.Fatalf("expected one error, got %v", r.errs)
	}
	if c := r.exitCode["req-plan"]; c == nil || *c != 1 {
		t.Fatalf("expected exit code 1, got %v", c)
	}
}

func TestCodexBackend_HappyPath(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "hi", ProjectPath: "/repo"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")

	peer.notify(codexrpc.NotifAgentMessageDelta, codexrpc.DeltaNotification{Delta: "hello", ThreadID: "th_test"})
	peer.notify(codexrpc.NotifTurnCompleted, codexrpc.TurnCompletedNotification{ThreadID: "th_test"})

	waitFor(t, func() bool { return r.exitCount() == 1 }, "turn/completed exit")
	if r.count(isType("session_init")) != 1 {
		t.Errorf("expected 1 session_init, got %d", r.count(isType("session_init")))
	}
	if r.count(isType("text_chunk")) != 1 {
		t.Errorf("expected 1 text_chunk, got %d", r.count(isType("text_chunk")))
	}
	if r.count(isType("task_complete")) != 1 {
		t.Errorf("expected 1 task_complete, got %d", r.count(isType("task_complete")))
	}
	r.mu.Lock()
	if len(r.exits) != 1 || r.exits[0] != "th_test" {
		t.Errorf("expected exit sessionID th_test, got %v", r.exits)
	}
	r.mu.Unlock()
}

func TestCodexBackend_ReasoningToThinking(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "hi"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")

	peer.notify(codexrpc.NotifReasoningTextDelta, codexrpc.DeltaNotification{Delta: "thinking...", ThreadID: "th_test"})
	peer.notify(codexrpc.NotifAgentMessageDelta, codexrpc.DeltaNotification{Delta: "answer", ThreadID: "th_test"})
	peer.notify(codexrpc.NotifTurnCompleted, codexrpc.TurnCompletedNotification{ThreadID: "th_test"})

	waitFor(t, func() bool { return r.exitCount() == 1 }, "exit")
	if r.count(isType("thinking_block_start")) != 1 {
		t.Errorf("expected 1 thinking_block_start, got %d", r.count(isType("thinking_block_start")))
	}
	if r.count(isType("thinking_delta")) != 1 {
		t.Errorf("expected 1 thinking_delta, got %d", r.count(isType("thinking_delta")))
	}
	// The block must close when assistant text begins.
	if r.count(isType("thinking_block_end")) < 1 {
		t.Errorf("expected thinking_block_end when text starts, got %d", r.count(isType("thinking_block_end")))
	}
}

func TestCodexBackend_ToolCallTranslation(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "run ls"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")

	peer.notify(codexrpc.NotifItemStarted, codexrpc.ItemNotification{ThreadID: "th_test", Item: codexrpc.ThreadItem{Type: "commandExecution", ID: "it_1", Command: "ls"}})
	exit := 0
	peer.notify(codexrpc.NotifItemCompleted, codexrpc.ItemNotification{ThreadID: "th_test", Item: codexrpc.ThreadItem{Type: "commandExecution", ID: "it_1", AggregatedOutput: "file.txt", ExitCode: &exit}})
	peer.notify(codexrpc.NotifTurnCompleted, codexrpc.TurnCompletedNotification{ThreadID: "th_test"})

	waitFor(t, func() bool { return r.exitCount() == 1 }, "exit")
	if r.count(isType("tool_call")) != 1 {
		t.Errorf("expected 1 tool_call, got %d", r.count(isType("tool_call")))
	}
	if r.count(isType("tool_result")) != 1 {
		t.Errorf("expected 1 tool_result, got %d", r.count(isType("tool_result")))
	}
}

func TestCodexBackend_ApprovalRoundTrip(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	// Install an ask callback that auto-allows.
	b.SetPermissionAskCallback(func(_ string, _ string, _ string, _ string, _ map[string]any, _ []types.PermissionOpt) chan string {
		ch := make(chan string, 1)
		ch <- "allow"
		return ch
	})

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "rm"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")

	// The peer sends an approval request; the backend must answer "accept".
	peer.request("99", codexrpc.ReqCommandApproval, codexrpc.CommandApprovalParams{ThreadID: "th_test", ItemID: "it_1", Command: "rm -rf x", Cwd: "/repo"})
	// The client's response goes back to the peer; confirm the client stays
	// healthy by completing the turn.
	peer.notify(codexrpc.NotifTurnCompleted, codexrpc.TurnCompletedNotification{ThreadID: "th_test"})
	waitFor(t, func() bool { return r.exitCount() == 1 }, "exit after approval")
}

func TestCodexBackend_Interrupt(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "hi"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")
	if !b.Cancel("req-1") {
		t.Fatal("Cancel returned false for active run")
	}
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnInterrupt) }, "turn/interrupt")
}

func TestCodexBackend_ResumeUsesThreadResume(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "hi", CliResumeSessionID: "th_prev"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodThreadResume) }, "thread/resume")
	if peer.sawMethod(codexrpc.MethodThreadStart) {
		t.Fatal("resume run must not call thread/start")
	}
}

func TestCodexBackend_Steer(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "hi"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")
	if err := b.WriteToStdin("req-1", "more context"); err != nil {
		t.Fatalf("WriteToStdin: %v", err)
	}
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnSteer) }, "turn/steer")
}

func TestCodexBackend_ProcessDeathFailsRuns(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	r := newRecorder()
	r.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-1", types.RunOptions{Model: "gpt-5-codex", Prompt: "hi"})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")
	// Kill the peer connection → OnClosed → active run fails.
	_ = peer.toClient.Close()
	waitFor(t, func() bool { return r.exitCount() == 1 }, "exit on process death")
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.errs) == 0 {
		t.Fatal("expected an error when codex process died")
	}
}
