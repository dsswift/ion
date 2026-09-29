package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeEngineEnv turns the test binary into a stand-in for a spawned `ion
// serve`: it listens on loopback TCP, prints its address, answers every
// command with ok, and on "shutdown" waits fakeEngineExitDelayEnv ms, writes
// the file named by fakeEngineMarkerEnv, and exits. With fakeEngineHangEnv set
// it never exits on its own.
const (
	fakeEngineEnv          = "ION_TEST_FAKE_ENGINE"
	fakeEngineExitDelayEnv = "ION_TEST_FAKE_ENGINE_EXIT_DELAY_MS"
	fakeEngineMarkerEnv    = "ION_TEST_FAKE_ENGINE_MARKER"
	fakeEngineHangEnv      = "ION_TEST_FAKE_ENGINE_HANG"
)

func TestMain(m *testing.M) {
	if os.Getenv(fakeEngineEnv) != "" {
		runFakeEngine()
		return
	}
	os.Exit(m.Run())
}

func runFakeEngine() {
	if os.Getenv(fakeEngineHangEnv) != "" {
		os.Stdout.WriteString("ready\n") //nolint:errcheck // helper protocol line
		time.Sleep(time.Hour)
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		os.Exit(3)
	}
	os.Stdout.WriteString(ln.Addr().String() + "\n") //nolint:errcheck // helper protocol line
	for {
		conn, err := ln.Accept()
		if err != nil {
			os.Exit(4)
		}
		line, err := bufio.NewReader(conn).ReadString('\n')
		if err != nil {
			conn.Close() //nolint:errcheck // helper
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			os.Exit(5)
		}
		reply, _ := json.Marshal(map[string]any{"requestId": msg["requestId"], "ok": true}) //nolint:errcheck // static shape
		conn.Write(append(reply, '\n'))                                                     //nolint:errcheck // helper
		conn.Close()                                                                        //nolint:errcheck // helper
		if msg["cmd"] == "shutdown" {
			delay, _ := strconv.Atoi(os.Getenv(fakeEngineExitDelayEnv)) //nolint:errcheck // zero delay on parse failure
			time.Sleep(time.Duration(delay) * time.Millisecond)
			os.WriteFile(os.Getenv(fakeEngineMarkerEnv), []byte("exited"), 0o644) //nolint:errcheck // parent asserts on it
			os.Exit(0)
		}
	}
}

// startFakeEngine starts the helper and returns its process and first stdout line.
func startFakeEngine(t *testing.T, env ...string) (*exec.Cmd, string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(append(os.Environ(), fakeEngineEnv+"=1"), env...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill() }) //nolint:errcheck // usually already exited
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("fake engine did not start: %v", err)
	}
	return cmd, strings.TrimSpace(line)
}

// When the prompt CLI started the engine, cleanup must not return until that
// engine has exited, so a container whose PID 1 is the CLI does not kill the
// engine mid-shutdown.
func TestCleanupEphemeralPromptWaitsForSpawnedEngineExit(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	marker := filepath.Join(t.TempDir(), "exited")
	const exitDelay = 700 * time.Millisecond
	cmd, addr := startFakeEngine(t,
		fakeEngineExitDelayEnv+"="+strconv.Itoa(int(exitDelay.Milliseconds())),
		fakeEngineMarkerEnv+"="+marker,
	)

	started := time.Now()
	cleanupEphemeralPrompt(addr, "prompt-test", cmd.Process)
	elapsed := time.Since(started)

	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("cleanup returned before the spawned engine finished shutting down (after %v)", elapsed)
	}
	if elapsed < exitDelay {
		t.Fatalf("cleanup returned after %v, before the engine's %v shutdown", elapsed, exitDelay)
	}
}

func TestWaitForSpawnedServerExitBounded(t *testing.T) {
	cmd, _ := startFakeEngine(t, fakeEngineHangEnv+"=1")

	started := time.Now()
	if waitForSpawnedServerExit(cmd.Process, 300*time.Millisecond) {
		t.Fatal("a process that never exits must not be reported as exited")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("wait overran its budget: %v", elapsed)
	}
}

func TestCleanupEphemeralPromptWithoutSpawnedEngine(t *testing.T) {
	cmd, addr := startFakeEngine(t,
		fakeEngineMarkerEnv+"="+filepath.Join(t.TempDir(), "exited"),
	)
	// An engine the CLI did not start is left running: no shutdown, no wait.
	cleanupEphemeralPrompt(addr, "prompt-test", nil)
	if cmd.ProcessState != nil {
		t.Fatal("engine the CLI did not start must not be shut down")
	}
	c, err := net.DialTimeout("tcp4", addr, time.Second)
	if err != nil {
		t.Fatalf("engine the CLI did not start should still be listening: %v", err)
	}
	c.Close() //nolint:errcheck // probe
}
