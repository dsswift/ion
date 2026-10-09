package server

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Profile kinds debug_profile accepts.
const (
	ProfileKindCPU       = "cpu"
	ProfileKindHeap      = "heap"
	ProfileKindGoroutine = "goroutine"
	ProfileKindTrace     = "trace"
	// defaultProfileSeconds is how long a cpu or trace capture records when
	// the command names no duration; maxProfileSeconds caps it.
	defaultProfileSeconds = 10
	maxProfileSeconds     = 300
)

// profilesDir is where captures land: <data dir>/profiles. A variable so a
// test can point it at a temporary directory.
var profilesDir = func() string { return filepath.Join(utils.IonDir(), "profiles") }

// dispatchDebugProfile captures one runtime profile of this daemon and
// answers with its path. A cpu or trace capture records for cmd.Seconds on
// its own goroutine and answers when the file is sealed, so the command lane
// is held only for the start. heap and goroutine capture at once.
func (s *Server) dispatchDebugProfile(conn net.Conn, cmd *protocol.ClientCommand) {
	kind := cmd.ProfileKind
	seconds := cmd.Seconds
	if seconds <= 0 {
		seconds = defaultProfileSeconds
	}
	if seconds > maxProfileSeconds {
		seconds = maxProfileSeconds
	}
	switch kind {
	case ProfileKindCPU, ProfileKindHeap, ProfileKindGoroutine, ProfileKindTrace:
	default:
		utils.LogWithFields(utils.LevelWarn, "server.debug_profile", "refused: unknown profile kind", map[string]any{"kind": kind, "request_id": cmd.RequestID})
		s.sendResult(conn, cmd, fmt.Errorf("debug_profile: unknown profileKind %q (cpu|heap|goroutine|trace)", kind), nil)
		return
	}
	dir := profilesDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		utils.LogWithFields(utils.LevelError, "server.debug_profile", "profiles dir unavailable", map[string]any{"dir": dir, "error": err.Error()})
		s.sendResult(conn, cmd, fmt.Errorf("debug_profile: %w", err), nil)
		return
	}
	ext := ".pprof"
	if kind == ProfileKindTrace {
		ext = ".trace"
	}
	path := filepath.Join(dir, fmt.Sprintf("%s-%s%s", kind, time.Now().UTC().Format("20060102T150405Z"), ext))
	utils.LogWithFields(utils.LevelInfo, "server.debug_profile", "capture starting", map[string]any{
		"kind": kind, "seconds": seconds, "path": path, "request_id": cmd.RequestID,
	})
	go func() {
		started := time.Now()
		err := captureProfile(kind, seconds, path)
		fields := map[string]any{"kind": kind, "path": path, "request_id": cmd.RequestID, "duration_ms": time.Since(started).Milliseconds()}
		if err != nil {
			fields["error"] = err.Error()
			utils.LogWithFields(utils.LevelError, "server.debug_profile", "capture failed", fields)
			s.sendResult(conn, cmd, fmt.Errorf("debug_profile %s: %w", kind, err), nil)
			return
		}
		utils.LogWithFields(utils.LevelInfo, "server.debug_profile", "capture written", fields)
		s.sendResult(conn, cmd, nil, map[string]any{"kind": kind, "path": path, "seconds": seconds})
	}()
}

// captureProfile writes one profile of kind to path. cpu and trace record
// for seconds; the others snapshot now. The file is removed on failure so a
// partial capture is never mistaken for a complete one.
func captureProfile(kind string, seconds int, path string) (err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
		if err != nil {
			if rmErr := os.Remove(path); rmErr != nil && !os.IsNotExist(rmErr) {
				utils.LogWithFields(utils.LevelInfo, "server.debug_profile", "partial capture not removed", map[string]any{"path": path, "error": rmErr.Error()})
			}
		}
	}()
	switch kind {
	case ProfileKindCPU:
		if err := pprof.StartCPUProfile(f); err != nil {
			return err
		}
		time.Sleep(time.Duration(seconds) * time.Second)
		pprof.StopCPUProfile()
		return nil
	case ProfileKindTrace:
		if err := trace.Start(f); err != nil {
			return err
		}
		time.Sleep(time.Duration(seconds) * time.Second)
		trace.Stop()
		return nil
	case ProfileKindHeap:
		runtime.GC()
		return pprof.Lookup("heap").WriteTo(f, 0)
	case ProfileKindGoroutine:
		return pprof.Lookup("goroutine").WriteTo(f, 0)
	}
	return fmt.Errorf("unknown profile kind %q", kind)
}
