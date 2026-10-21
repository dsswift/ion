//go:build integration

// End-to-end test for `ion acp`: a real engine server on a socket, the ACP
// agent attached to it over that socket, and an ACP client on the agent's
// stdio. The mock backend plays the run, so the whole wire is exercised
// without a provider: session/new, session/prompt streaming, a tool call,
// a permission round trip, and the stop reason.
package integration

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/acpagent"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// acpTestClient is a minimal ACP client over the agent's stdio pipes.
type acpTestClient struct {
	t     *testing.T
	in    io.WriteCloser
	mu    sync.Mutex
	seq   int64
	waits map[int64]chan json.RawMessage
	notes chan acpagent.SessionNotification
}

func newACPTestClient(t *testing.T, in io.WriteCloser, out io.Reader) *acpTestClient {
	c := &acpTestClient{t: t, in: in, waits: map[int64]chan json.RawMessage{}, notes: make(chan acpagent.SessionNotification, 256)}
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
		for scanner.Scan() {
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
				t.Errorf("client: bad frame: %v", err)
				continue
			}
			switch {
			case msg.Method == acpagent.NotifSessionUpdate:
				var n acpagent.SessionNotification
				if err := json.Unmarshal(msg.Params, &n); err != nil {
					t.Errorf("client: bad update: %v", err)
					continue
				}
				c.notes <- n
			case msg.Method == acpagent.ReqRequestPermission:
				var req acpagent.RequestPermissionRequest
				if err := json.Unmarshal(msg.Params, &req); err != nil || len(req.Options) == 0 {
					t.Errorf("client: bad permission request: %v", err)
					continue
				}
				c.write(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": acpagent.RequestPermissionResponse{Outcome: acpagent.PermissionOutcome{Outcome: "selected", OptionID: req.Options[0].OptionID}}})
			case msg.Method != "":
				c.write(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{}})
			default:
				var id int64
				if err := json.Unmarshal(msg.ID, &id); err != nil {
					continue
				}
				c.mu.Lock()
				ch := c.waits[id]
				delete(c.waits, id)
				c.mu.Unlock()
				if ch == nil {
					continue
				}
				if len(msg.Error) > 0 && string(msg.Error) != "null" {
					ch <- json.RawMessage(`{"__error":` + string(msg.Error) + `}`)
				} else {
					ch <- msg.Result
				}
			}
		}
	}()
	return c
}

func (c *acpTestClient) write(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("marshal: %v", err)
	}
	if _, err := c.in.Write(append(data, '\n')); err != nil {
		c.t.Logf("write: %v", err)
	}
}

func (c *acpTestClient) call(method string, params, out any) string {
	c.mu.Lock()
	c.seq++
	id := c.seq
	ch := make(chan json.RawMessage, 1)
	c.waits[id] = ch
	c.mu.Unlock()
	c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	select {
	case raw := <-ch:
		var errWrap struct {
			Err *struct {
				Message string `json:"message"`
			} `json:"__error"`
		}
		if json.Unmarshal(raw, &errWrap) == nil && errWrap.Err != nil {
			return errWrap.Err.Message
		}
		if out != nil {
			if err := json.Unmarshal(raw, out); err != nil {
				return "decode: " + err.Error()
			}
		}
		return ""
	case <-time.After(30 * time.Second):
		return "no response"
	}
}

func (c *acpTestClient) next(kind string) acpagent.SessionUpdate {
	c.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case n := <-c.notes:
			if n.Update.SessionUpdate == kind {
				return n.Update
			}
		case <-deadline:
			c.t.Fatalf("no %s update arrived", kind)
			return acpagent.SessionUpdate{}
		}
	}
}

func TestACPAgentServesTheEngineOverItsSocket(t *testing.T) {
	// A unix socket path is capped at 104 bytes on macOS; t.TempDir() is
	// longer than that under the default TMPDIR.
	dir, err := os.MkdirTemp("", "ion-acp-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) }) //nolint:errcheck // temp dir cleanup
	sockPath := filepath.Join(dir, "acp.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	engine, err := acpagent.DialEngine("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	agentIn, clientWrites := io.Pipe()
	clientReads, agentOut := io.Pipe()
	agent := acpagent.New(engine, agentOut, agentIn, acpagent.Options{Version: "test"})
	t.Cleanup(func() {
		clientWrites.Close() //nolint:errcheck // teardown
		agent.Shutdown(t.Context())
		engine.Close() //nolint:errcheck // teardown
	})
	c := newACPTestClient(t, clientWrites, clientReads)

	var init acpagent.InitializeResponse
	if msg := c.call(acpagent.MethodInitialize, acpagent.InitializeRequest{ProtocolVersion: 1}, &init); msg != "" {
		t.Fatalf("initialize: %s", msg)
	}
	if init.AgentInfo.Name != "ion" || !init.AgentCapabilities.LoadSession {
		t.Fatalf("initialize = %+v", init)
	}
	var created acpagent.SessionResponse
	if msg := c.call(acpagent.MethodSessionNew, acpagent.NewSessionRequest{Cwd: testWorkDir()}, &created); msg != "" {
		t.Fatalf("session/new: %s", msg)
	}
	key := created.SessionID
	if key == "" || created.Modes == nil || created.Modes.CurrentModeID != acpagent.ModeBuild {
		t.Fatalf("session/new = %+v", created)
	}

	// The engine's session exists under the agent's key.
	var found bool
	for _, si := range srv.SessionManager().ListSessions() {
		if si.Key == key {
			found = true
		}
	}
	if !found {
		t.Fatalf("engine has no session %s", key)
	}

	// Prompt: the mock backend plays a tool call, its result, text, and completion.
	promptDone := make(chan string, 1)
	go func() {
		var pr acpagent.PromptResponse
		msg := c.call(acpagent.MethodSessionPrompt, acpagent.PromptRequest{SessionID: key, Prompt: []acpagent.ContentBlock{{Type: "text", Text: "list files"}}}, &pr)
		if msg == "" {
			msg = "stop:" + pr.StopReason
		}
		promptDone <- msg
	}()
	runID := waitForRun(t, mb)
	mb.EmitNormalized(runID, types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Bash", ToolID: "t1"}})
	mb.EmitNormalized(runID, types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "t1", Content: "a.go\nb.go"}})
	mb.EmitNormalized(runID, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "Two files."}})
	mb.EmitNormalized(runID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "Two files.", Reason: types.TaskCompletionReasonNormal}})
	code := 0
	mb.EmitExit(runID, &code, nil, "")

	if u := c.next(acpagent.UpdateToolCall); u.ToolCallID != "t1" || u.Kind != "execute" {
		t.Fatalf("tool_call = %+v", u)
	}
	if u := c.next(acpagent.UpdateToolCallUpdate); u.Status != "completed" || len(u.ToolContent) != 1 || u.ToolContent[0].Content.Text != "a.go\nb.go" {
		t.Fatalf("tool_call_update = %+v", u)
	}
	if u := c.next(acpagent.UpdateAgentMessageChunk); u.Content == nil || u.Content.Text != "Two files." {
		t.Fatalf("chunk = %+v", u)
	}
	select {
	case msg := <-promptDone:
		if msg != "stop:end_turn" {
			t.Fatalf("prompt = %s", msg)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("prompt never returned")
	}

	// Shutdown stops the engine session.
	agent.Shutdown(t.Context())
	for _, si := range srv.SessionManager().ListSessions() {
		if si.Key == key {
			t.Fatalf("session %s survived agent shutdown", key)
		}
	}
}

// waitForRun returns the run id of the first run the mock backend started.
func waitForRun(t *testing.T, mb *helpers.MockBackend) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if ids := mb.RunIDs(); len(ids) > 0 {
			return ids[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no run started")
	return ""
}
