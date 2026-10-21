package acpagent

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// acpClient is a minimal ACP client over the agent's stdio pipes: it sends
// requests, collects notifications, and answers agent requests through a
// handler the test sets.
type acpClient struct {
	t      *testing.T
	in     io.WriteCloser // what the agent reads
	out    io.Reader      // what the agent writes
	seq    int64
	mu     sync.Mutex
	waits  map[int64]chan json.RawMessage
	notes  chan SessionNotification
	onReq  func(method string, params json.RawMessage) any
	closed chan struct{}
}

func startAgent(t *testing.T, f *fakeEngine, opts Options) (*Agent, *acpClient) {
	t.Helper()
	engine, err := DialEngine("unix", f.sock)
	if err != nil {
		t.Fatalf("dial fake engine: %v", err)
	}
	agentIn, clientWrites := io.Pipe()
	clientReads, agentOut := io.Pipe()
	a := New(engine, agentOut, agentIn, opts)
	c := &acpClient{t: t, in: clientWrites, out: clientReads, waits: map[int64]chan json.RawMessage{}, notes: make(chan SessionNotification, 256), closed: make(chan struct{})}
	go c.readLoop()
	t.Cleanup(func() {
		clientWrites.Close() //nolint:errcheck // test teardown
		engine.Close()       //nolint:errcheck // test teardown
	})
	return a, c
}

func (c *acpClient) readLoop() {
	defer close(c.closed)
	scanner := bufio.NewScanner(c.out)
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
			c.t.Errorf("client: bad frame: %v", err)
			continue
		}
		switch {
		case msg.Method == NotifSessionUpdate:
			var n SessionNotification
			if err := json.Unmarshal(msg.Params, &n); err != nil {
				c.t.Errorf("client: bad update: %v", err)
				continue
			}
			c.notes <- n
		case msg.Method != "":
			var result any = map[string]any{}
			if c.onReq != nil {
				result = c.onReq(msg.Method, msg.Params)
			}
			c.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(msg.ID), "result": result})
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
}

func (c *acpClient) write(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("client: marshal: %v", err)
	}
	if _, err := c.in.Write(append(data, '\n')); err != nil {
		c.t.Logf("client: write: %v", err)
	}
}

// call sends a request and decodes the result into out. An error result
// fails the test unless wantErr is set, in which case it is returned.
func (c *acpClient) call(method string, params any, out any) string {
	c.t.Helper()
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
				c.t.Fatalf("%s: decode result: %v (%s)", method, err, raw)
			}
		}
		return ""
	case <-time.After(10 * time.Second):
		c.t.Fatalf("%s: no response", method)
		return ""
	}
}

// promptResult is how a background prompt ended: its response or the
// JSON-RPC error message.
type promptResult struct {
	PromptResponse
	err string
}

// sendPrompt runs session/prompt on its own goroutine and delivers the
// outcome on the returned channel; test assertions stay on the test
// goroutine.
func (c *acpClient) sendPrompt(req PromptRequest) <-chan promptResult {
	done := make(chan promptResult, 1)
	go func() {
		var pr promptResult
		pr.err = c.send(MethodSessionPrompt, req, &pr.PromptResponse)
		done <- pr
	}()
	return done
}

// send is call without test failure: it returns the error message, or the
// transport failure as text, so a goroutine can use it.
func (c *acpClient) send(method string, params any, out ...any) string {
	c.mu.Lock()
	c.seq++
	id := c.seq
	ch := make(chan json.RawMessage, 1)
	c.waits[id] = ch
	c.mu.Unlock()
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		return "marshal: " + err.Error()
	}
	if _, err := c.in.Write(append(data, '\n')); err != nil {
		return "write: " + err.Error()
	}
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
		if len(out) > 0 && out[0] != nil {
			if err := json.Unmarshal(raw, out[0]); err != nil {
				return "decode: " + err.Error()
			}
		}
		return ""
	case <-time.After(10 * time.Second):
		return "no response"
	}
}

func (c *acpClient) notify(method string, params any) {
	c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

// next returns the next update of the given kind, failing after a timeout.
func (c *acpClient) next(kind string) SessionUpdate {
	c.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case n := <-c.notes:
			if n.Update.SessionUpdate == kind {
				return n.Update
			}
		case <-deadline:
			c.t.Fatalf("no %s update arrived", kind)
			return SessionUpdate{}
		}
	}
}

func (c *acpClient) initialize(caps ClientCapabilities) InitializeResponse {
	c.t.Helper()
	var res InitializeResponse
	if msg := c.call(MethodInitialize, InitializeRequest{ProtocolVersion: 1, ClientCapabilities: caps, ClientInfo: &Implementation{Name: "test", Version: "0"}}, &res); msg != "" {
		c.t.Fatalf("initialize: %s", msg)
	}
	return res
}

func (c *acpClient) newSession(cwd string) SessionResponse {
	c.t.Helper()
	var res SessionResponse
	if msg := c.call(MethodSessionNew, NewSessionRequest{Cwd: cwd, McpServers: nil}, &res); msg != "" {
		c.t.Fatalf("session/new: %s", msg)
	}
	return res
}
