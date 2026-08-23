package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

const promptTimeoutHelperEnv = "ION_PROMPT_TIMEOUT_HELPER"

func TestPromptTimeoutCleanupHelper(t *testing.T) {
	if os.Getenv(promptTimeoutHelperEnv) != "1" {
		return
	}

	cmdPrompt([]string{"timeout cleanup"}, map[string]string{
		"timeout": "50ms",
	}, nil)
}

// TestPromptTimeoutCleanupStopsEphemeralSessionWithoutAbort exercises the CLI
// against a socket peer that never emits an idle event. The prompt must time
// out, stop its ephemeral session, and exit instead of waiting for a response
// to the fire-and-forget abort command.
func TestPromptTimeoutCleanupStopsEphemeralSessionWithoutAbort(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil {
			t.Errorf("close listener: %v", closeErr)
		}
	})

	commands := make(chan string, 4)
	go servePromptTimeoutSocket(t, listener, commands)

	command := exec.Command(os.Args[0], "-test.run=TestPromptTimeoutCleanupHelper")
	command.Env = append(os.Environ(),
		promptTimeoutHelperEnv+"=1",
		"ION_SOCKET_PATH="+listener.Addr().String(),
	)
	if err := command.Run(); err == nil {
		t.Fatal("prompt command succeeded, want timeout exit")
	} else if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 124 {
		t.Fatalf("prompt command error = %v, want exit 124", err)
	}

	got := receivePromptTimeoutCommands(t, commands, 3)
	want := []string{"start_session", "send_prompt", "stop_session"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commands = %v, want %v", got, want)
	}
	assertNoPromptTimeoutCommand(t, commands)
}

// TestCleanupEphemeralPromptShutsDownOnlyOwnedServer pins the cleanup sequence
// for a daemon that the CLI started itself. stop_session supplies the required
// cancellation, then shutdown releases that owned daemon.
func TestCleanupEphemeralPromptShutsDownOnlyOwnedServer(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil {
			t.Errorf("close listener: %v", closeErr)
		}
	})

	commands := make(chan string, 2)
	go servePromptTimeoutSocket(t, listener, commands)
	t.Setenv("ION_SOCKET_PATH", listener.Addr().String())
	cleanupEphemeralPrompt(listener.Addr().String(), "ephemeral-key", true)

	got := receivePromptTimeoutCommands(t, commands, 2)
	want := []string{"stop_session", "shutdown"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cleanup commands = %v, want %v", got, want)
	}
}

func receivePromptTimeoutCommands(t *testing.T, commands <-chan string, count int) []string {
	t.Helper()

	got := make([]string, 0, count)
	for range count {
		select {
		case command := <-commands:
			got = append(got, command)
		case <-time.After(time.Second):
			t.Fatalf("received commands = %v, want %d commands", got, count)
		}
	}
	return got
}

func assertNoPromptTimeoutCommand(t *testing.T, commands <-chan string) {
	t.Helper()
	select {
	case command := <-commands:
		t.Fatalf("unexpected command %q", command)
	case <-time.After(100 * time.Millisecond):
	}
}

func servePromptTimeoutSocket(t *testing.T, listener net.Listener, commands chan<- string) {
	t.Helper()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go servePromptTimeoutConnection(t, conn, commands)
	}
}

func servePromptTimeoutConnection(t *testing.T, conn net.Conn, commands chan<- string) {
	t.Helper()
	defer func() {
		if err := conn.Close(); err != nil {
			t.Errorf("close connection: %v", err)
		}
	}()

	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}

	var request struct {
		Command   string `json:"cmd"`
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
		t.Errorf("decode command: %v", err)
		return
	}
	commands <- request.Command

	response, err := json.Marshal(map[string]string{"requestId": request.RequestID})
	if err != nil {
		t.Errorf("encode response: %v", err)
		return
	}
	if _, err := conn.Write(append(response, '\n')); err != nil {
		t.Errorf("write response: %v", err)
	}
}
