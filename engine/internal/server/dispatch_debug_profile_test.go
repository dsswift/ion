package server

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
)

// runDebugProfile dispatches debug_profile and returns the decoded reply.
func runDebugProfile(t *testing.T, kind string, seconds int) protocol.ServerResult {
	t.Helper()
	dir := t.TempDir()
	prev := profilesDir
	profilesDir = func() string { return dir }
	t.Cleanup(func() { profilesDir = prev })

	srv := NewServer(shortSocketPath(t), newMockBackend())
	server, client := net.Pipe()
	t.Cleanup(func() { server.Close(); client.Close() }) //nolint:errcheck // test teardown
	// A refusal is written before dispatchDebugProfile returns, and a pipe
	// write blocks until it is read, so dispatch runs beside the reader.
	go srv.dispatchDebugProfile(server, &protocol.ClientCommand{Cmd: "debug_profile", RequestID: "p1", ProfileKind: kind, Seconds: seconds})

	if err := client.SetReadDeadline(time.Now().Add(time.Duration(seconds)*time.Second + 10*time.Second)); err != nil {
		t.Fatalf("deadline: %v", err)
	}
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	var result protocol.ServerResult
	if err := json.Unmarshal([]byte(line), &result); err != nil {
		t.Fatalf("decode reply %q: %v", line, err)
	}
	return result
}

func TestDebugProfileWritesEachKind(t *testing.T) {
	for _, tc := range []struct {
		kind, ext string
		seconds   int
	}{
		{ProfileKindHeap, ".pprof", 0},
		{ProfileKindGoroutine, ".pprof", 0},
		{ProfileKindCPU, ".pprof", 1},
		{ProfileKindTrace, ".trace", 1},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			result := runDebugProfile(t, tc.kind, tc.seconds)
			if !result.OK {
				t.Fatalf("reply = %+v", result)
			}
			data, _ := result.Data.(map[string]any) //nolint:errcheck // checked below
			path, _ := data["path"].(string)        //nolint:errcheck // checked below
			if !strings.HasPrefix(filepath.Base(path), tc.kind+"-") || filepath.Ext(path) != tc.ext {
				t.Fatalf("path = %q", path)
			}
			info, err := os.Stat(path)
			if err != nil || info.Size() == 0 {
				t.Fatalf("profile file: size=%v err=%v", info, err)
			}
		})
	}
}

func TestDebugProfileRefusesUnknownKind(t *testing.T) {
	result := runDebugProfile(t, "mutex", 0)
	if result.OK || !strings.Contains(result.Error, "unknown profileKind") {
		t.Fatalf("reply = %+v, want an unknown-kind error", result)
	}
}
