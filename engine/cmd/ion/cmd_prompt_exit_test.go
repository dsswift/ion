package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const promptExitHelperEnv = "ION_PROMPT_EXIT_HELPER"

// promptExitKey is the session key the helper prompts under, so the fake
// engine can address its stream events to it.
const promptExitKey = "prompt-exit-test"

func TestPromptExitHelper(t *testing.T) {
	if os.Getenv(promptExitHelperEnv) != "1" {
		return
	}
	cmdPrompt([]string{"exit status"}, map[string]string{"key": promptExitKey, "attach": "true", "timeout": "5s"}, nil)
}

// TestStreamUntilIdleReportsHowTheRunEnded pins each way a streamed run ends
// to its exit status: only an idle session is success.
func TestStreamUntilIdleReportsHowTheRunEnded(t *testing.T) {
	cases := []struct {
		name   string
		events []string
		want   streamEnd
		code   int
	}{
		{"idle", []string{`{"type":"engine_text_delta","text":"hi"}`, `{"type":"engine_status","fields":{"state":"idle"}}`}, streamIdle, 0},
		{"error", []string{`{"type":"engine_error","message":"no model configured"}`}, streamFailed, 1},
		{"closed", nil, streamLost, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			addr := serveStreamEvents(t, tc.events, true)
			got := streamUntilIdle(addr, promptExitKey, 2*time.Second)
			if got != tc.want || got.exitCode() != tc.code {
				t.Fatalf("streamUntilIdle = %v (exit %d), want %v (exit %d)", got, got.exitCode(), tc.want, tc.code)
			}
		})
	}
	t.Run("timeout", func(t *testing.T) {
		addr := serveStreamEvents(t, nil, false)
		if got := streamUntilIdle(addr, promptExitKey, 50*time.Millisecond); got != streamTimedOut || got.exitCode() != 124 {
			t.Fatalf("streamUntilIdle = %v, want streamTimedOut (exit 124)", got)
		}
	})
}

// TestPromptExitsNonZeroWhenTheRunFails runs the prompt command against an
// engine that accepts the prompt and then reports an error. The command must
// fail, so a script running it does not read an empty answer as success.
func TestPromptExitsNonZeroWhenTheRunFails(t *testing.T) {
	addr := serveStreamEvents(t, []string{`{"type":"engine_error","message":"no model configured"}`}, true)

	command := exec.Command(os.Args[0], "-test.run=^TestPromptExitHelper$")
	command.Env = append(os.Environ(), promptExitHelperEnv+"=1", "ION_SOCKET_PATH="+addr, "ION_DATA_DIR="+t.TempDir())
	var exitErr *exec.ExitError
	if err := command.Run(); !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("prompt command error = %v, want exit 1", err)
	}
}

// serveStreamEvents is a fake engine. A connection that sends a command gets
// an answer to it; a connection that sends nothing is a stream subscriber and
// gets `events` for promptExitKey, then is closed when closeAfter is set or
// held open otherwise.
func serveStreamEvents(t *testing.T, events []string, closeAfter bool) string {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil {
			t.Errorf("close listener: %v", closeErr)
		}
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveStreamConnection(t, conn, events, closeAfter)
		}
	}()
	return listener.Addr().String()
}

func serveStreamConnection(t *testing.T, conn net.Conn, events []string, closeAfter bool) {
	defer func() { conn.Close() }() //nolint:errcheck // test peer teardown
	if err := conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
		t.Errorf("set read deadline: %v", err)
		return
	}
	scanner := bufio.NewScanner(conn)
	if scanner.Scan() {
		var request struct {
			RequestID string `json:"requestId"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			t.Errorf("decode command: %v", err)
			return
		}
		response, err := json.Marshal(map[string]any{"requestId": request.RequestID, "ok": true})
		if err != nil {
			t.Errorf("encode response: %v", err)
			return
		}
		if _, err := conn.Write(append(response, '\n')); err != nil {
			t.Errorf("write response: %v", err)
		}
		return
	}
	var lines []string
	for _, event := range events {
		lines = append(lines, `{"key":"`+promptExitKey+`","event":`+event+`}`)
	}
	if len(lines) > 0 {
		if _, err := conn.Write([]byte(strings.Join(lines, "\n") + "\n")); err != nil {
			t.Errorf("write events: %v", err)
			return
		}
	}
	if !closeAfter {
		time.Sleep(time.Second)
	}
}
