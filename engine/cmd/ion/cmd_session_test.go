package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// serveOneCommand answers the first NDJSON command on a unix socket with the
// given data, echoing its requestId, the way the engine answers list_sessions.
func serveOneCommand(t *testing.T, wantCmd string, data any) string {
	t.Helper()
	// A unix socket path is capped near 104 bytes on macOS; t.TempDir()
	// embeds the test name and overruns it.
	dir, err := os.MkdirTemp("", "ion")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) }) //nolint:errcheck // test temp dir cleanup
	sock := filepath.Join(dir, "engine.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() }) //nolint:errcheck // test listener cleanup
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close() //nolint:errcheck // test conn cleanup
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			return
		}
		var cmd map[string]any
		if json.Unmarshal(line, &cmd) != nil || cmd["cmd"] != wantCmd {
			return
		}
		reply, _ := json.Marshal(map[string]any{"cmd": "result", "requestId": cmd["requestId"], "ok": true, "data": data}) //nolint:errcheck // fixed test payload
		conn.Write(append(reply, '\n'))                                                                                    //nolint:errcheck // test reply
	}()
	return sock
}

var twoSessions = []map[string]any{
	{"key": "tab-1", "hasActiveRun": true, "toolCount": 12, "conversationId": "conv-a"},
	{"key": "tab-2", "hasActiveRun": false, "toolCount": 3},
}

func TestRunStatus_PrintsWhatListSessionsSends(t *testing.T) {
	sock := serveOneCommand(t, "list_sessions", twoSessions)
	var out bytes.Buffer
	if err := runStatus(&out, sock, false); err != nil {
		t.Fatalf("runStatus: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("want header, rule, 2 rows; got %q", out.String())
	}
	for _, col := range []string{"KEY", "CONVERSATION", "ACTIVE", "TOOLS"} {
		if !strings.Contains(lines[0], col) {
			t.Errorf("header %q lacks %s", lines[0], col)
		}
	}
	if f := strings.Fields(lines[2]); strings.Join(f, " ") != "tab-1 conv-a yes 12" {
		t.Errorf("row 1 = %q", lines[2])
	}
	if f := strings.Fields(lines[3]); strings.Join(f, " ") != "tab-2 - no 3" {
		t.Errorf("row 2 = %q", lines[3])
	}
}

func TestRunStatus_JSON(t *testing.T) {
	sock := serveOneCommand(t, "list_sessions", twoSessions)
	var out bytes.Buffer
	if err := runStatus(&out, sock, true); err != nil {
		t.Fatalf("runStatus: %v", err)
	}
	var got []map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("output is not a JSON array: %v\n%s", err, out.String())
	}
	if len(got) != 2 || got[0]["key"] != "tab-1" || got[0]["hasActiveRun"] != true || got[1]["toolCount"] != float64(3) {
		t.Errorf("json = %v", got)
	}
}

func TestRunStatus_Empty(t *testing.T) {
	sock := serveOneCommand(t, "list_sessions", []any{})
	var out bytes.Buffer
	if err := runStatus(&out, sock, false); err != nil {
		t.Fatalf("runStatus: %v", err)
	}
	if strings.TrimSpace(out.String()) != "No active sessions" {
		t.Errorf("got %q", out.String())
	}
}
