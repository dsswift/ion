package acpagent

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeEngine is a scripted engine socket: it records every command, answers
// the ones the real daemon answers, and lets a test push events for a key.
type fakeEngine struct {
	t        *testing.T
	listener net.Listener
	sock     string

	mu       sync.Mutex
	conns    []net.Conn
	commands []map[string]any
	gotCmd   chan map[string]any
	// history is what load_session_history returns.
	history []map[string]any
	// models is what list_models returns.
	models []map[string]any
	// failPrompt makes send_prompt answer with an error.
	failPrompt string
	// failStart makes start_session answer with an error carrying this
	// policy failure id.
	failStart string
	// loginURL is what oidc_begin_login answers with.
	loginURL string
}

func newFakeEngine(t *testing.T) *fakeEngine {
	t.Helper()
	dir, err := os.MkdirTemp("", "acp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) }) //nolint:errcheck // temp dir cleanup
	sock := filepath.Join(dir, "e.sock")
	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &fakeEngine{t: t, listener: listener, sock: sock, gotCmd: make(chan map[string]any, 64)}
	t.Cleanup(func() { listener.Close() }) //nolint:errcheck // test teardown
	go f.accept()
	return f
}

func (f *fakeEngine) accept() {
	for {
		conn, err := f.listener.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns = append(f.conns, conn)
		f.mu.Unlock()
		go f.serve(conn)
	}
}

func (f *fakeEngine) serve(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for scanner.Scan() {
		var cmd map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			f.t.Errorf("fake engine: bad command: %v", err)
			continue
		}
		f.mu.Lock()
		f.commands = append(f.commands, cmd)
		f.mu.Unlock()
		f.gotCmd <- cmd
		f.answer(conn, cmd)
	}
}

func (f *fakeEngine) answer(conn net.Conn, cmd map[string]any) {
	name, _ := cmd["cmd"].(string)
	reqID, _ := cmd["requestId"].(string)
	res := map[string]any{"cmd": "result", "requestId": reqID, "ok": true}
	switch name {
	case "stop_session", "set_plan_mode", "oidc_logout":
	case "start_session":
		f.mu.Lock()
		failure := f.failStart
		f.mu.Unlock()
		if failure != "" {
			res["ok"] = false
			res["error"] = "refused: " + failure
			res["policyFailure"] = failure
		}
	case "oidc_identity":
		res["data"] = map[string]any{"signedIn": false, "requireOperatorIdentity": true}
	case "oidc_begin_login":
		f.mu.Lock()
		res["data"] = map[string]any{"authorizationUrl": f.loginURL}
		f.mu.Unlock()
	case "send_prompt":
		f.mu.Lock()
		fail := f.failPrompt
		f.mu.Unlock()
		if fail != "" {
			res["ok"] = false
			res["error"] = fail
		}
	case "list_models":
		f.mu.Lock()
		res["data"] = map[string]any{"models": f.models}
		f.mu.Unlock()
	case "load_session_history":
		f.mu.Lock()
		res["data"] = f.history
		f.mu.Unlock()
	default:
		return // fire-and-forget commands get no result
	}
	f.write(conn, res)
}

func (f *fakeEngine) write(conn net.Conn, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		f.t.Errorf("fake engine: marshal: %v", err)
		return
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		f.t.Logf("fake engine: write: %v", err)
	}
}

// emit broadcasts one event for key to every connection, wrapped the way
// the daemon wraps it.
func (f *fakeEngine) emit(key string, event map[string]any) {
	f.mu.Lock()
	conns := append([]net.Conn(nil), f.conns...)
	f.mu.Unlock()
	for _, c := range conns {
		f.write(c, map[string]any{"key": key, "event": event})
	}
}

// waitCmd returns the next command with the given name, failing the test
// when none arrives in time.
func (f *fakeEngine) waitCmd(name string) map[string]any {
	f.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case cmd := <-f.gotCmd:
			if cmd["cmd"] == name {
				return cmd
			}
		case <-deadline:
			f.t.Fatalf("no %s command arrived", name)
			return nil
		}
	}
}

func (f *fakeEngine) close() {
	f.listener.Close() //nolint:errcheck // test teardown
	f.mu.Lock()
	for _, c := range f.conns {
		c.Close() //nolint:errcheck // test teardown
	}
	f.mu.Unlock()
}
