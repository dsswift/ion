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
		{"session died", []string{`{"type":"engine_dead"}`}, streamFailed, 1},
		{"closed", nil, streamLost, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			addr := serveStreamEvents(t, nil, tc.events, true)
			got := streamUntilIdle(openTestPromptStream(t, addr, 2*time.Second), promptExitKey)
			if got != tc.want || got.exitCode() != tc.code {
				t.Fatalf("streamUntilIdle = %v (exit %d), want %v (exit %d)", got, got.exitCode(), tc.want, tc.code)
			}
		})
	}
	t.Run("timeout", func(t *testing.T) {
		addr := serveStreamEvents(t, nil, nil, false)
		if got := streamUntilIdle(openTestPromptStream(t, addr, 50*time.Millisecond), promptExitKey); got != streamTimedOut || got.exitCode() != 124 {
			t.Fatalf("streamUntilIdle = %v, want streamTimedOut (exit 124)", got)
		}
	})
}

// TestPromptStreamKeepsEventsSentBeforeTheAnswer pins that an event the engine
// writes before it answers the prompt still reaches the run's stream.
func TestPromptStreamKeepsEventsSentBeforeTheAnswer(t *testing.T) {
	addr := serveStreamEvents(t, []string{`{"type":"engine_status","fields":{"state":"idle"}}`}, nil, true)
	if got := streamUntilIdle(openTestPromptStream(t, addr, 2*time.Second), promptExitKey); got != streamIdle {
		t.Fatalf("streamUntilIdle = %v, want streamIdle", got)
	}
}

func openTestPromptStream(t *testing.T, addr string, deadline time.Duration) *promptStream {
	t.Helper()
	stream, err := openPromptStream(addr, map[string]interface{}{"cmd": "send_prompt", "key": promptExitKey, "text": "hi"}, deadline)
	if err != nil {
		t.Fatalf("openPromptStream: %v", err)
	}
	t.Cleanup(stream.close)
	return stream
}

// TestPromptExitsNonZeroWhenTheRunFails runs the prompt command against an
// engine that accepts the prompt and then reports an error. The command must
// fail, so a script running it does not read an empty answer as success.
func TestPromptExitsNonZeroWhenTheRunFails(t *testing.T) {
	addr := serveStreamEvents(t, nil, []string{`{"type":"engine_error","message":"no model configured"}`}, true)

	command := exec.Command(os.Args[0], "-test.run=^TestPromptExitHelper$")
	command.Env = append(os.Environ(), promptExitHelperEnv+"=1", "ION_SOCKET_PATH="+addr, "ION_DATA_DIR="+t.TempDir())
	var exitErr *exec.ExitError
	if err := command.Run(); !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("prompt command error = %v, want exit 1", err)
	}
}

// TestPromptAttachStreamsOnThePromptConnection runs `ion prompt --attach`
// against an engine that streams a run only to the connection that sent its
// prompt, as the engine does for the session's owner. The command must read
// the run there and exit 0 when the session goes idle.
func TestPromptAttachStreamsOnThePromptConnection(t *testing.T) {
	addr := serveStreamEvents(t, nil, []string{`{"type":"engine_text_delta","text":"done"}`, `{"type":"engine_status","fields":{"state":"idle"}}`}, true)

	command := exec.Command(os.Args[0], "-test.run=^TestPromptExitHelper$")
	command.Env = append(os.Environ(), promptExitHelperEnv+"=1", "ION_SOCKET_PATH="+addr, "ION_DATA_DIR="+t.TempDir())
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("prompt command error = %v, want exit 0; output:\n%s", err, out)
	}
}

// serveStreamEvents is a fake engine. Every connection sends one command and
// gets an answer to it. A send_prompt connection then streams the run, the
// way the engine streams to the connection that owns the session: `early`
// before the answer, `events` after it, all for promptExitKey. The stream is
// closed when closeAfter is set and held open otherwise. Every other command
// connection is closed after its answer, so a CLI that streams anywhere but
// the prompt's own connection sees no events.
func serveStreamEvents(t *testing.T, early, events []string, closeAfter bool) string {
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
			go serveStreamConnection(t, conn, early, events, closeAfter)
		}
	}()
	return listener.Addr().String()
}

func serveStreamConnection(t *testing.T, conn net.Conn, early, events []string, closeAfter bool) {
	defer func() { conn.Close() }() //nolint:errcheck // test peer teardown
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Errorf("set read deadline: %v", err)
		return
	}
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}
	var request struct {
		Cmd       string `json:"cmd"`
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
		t.Errorf("decode command: %v", err)
		return
	}
	streaming := request.Cmd == "send_prompt"
	if streaming && !writeStreamEvents(t, conn, early) {
		return
	}
	response, err := json.Marshal(map[string]any{"requestId": request.RequestID, "ok": true})
	if err != nil {
		t.Errorf("encode response: %v", err)
		return
	}
	if _, err := conn.Write(append(response, '\n')); err != nil {
		t.Errorf("write response: %v", err)
		return
	}
	if !streaming || !writeStreamEvents(t, conn, events) {
		return
	}
	if !closeAfter {
		time.Sleep(time.Second)
	}
}

func writeStreamEvents(t *testing.T, conn net.Conn, events []string) bool {
	if len(events) == 0 {
		return true
	}
	var lines []string
	for _, event := range events {
		lines = append(lines, `{"key":"`+promptExitKey+`","event":`+event+`}`)
	}
	if _, err := conn.Write([]byte(strings.Join(lines, "\n") + "\n")); err != nil {
		t.Errorf("write events: %v", err)
		return false
	}
	return true
}
