package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// beatInterval is how often the heartbeat ticker updates lastBeat.
// Two beats without an update is the staleness threshold for UNCLEAN classification.
const beatInterval = 5 * time.Second

// exitRecord is the JSON schema for ~/.ion/engine.exit.
type exitRecord struct {
	Pid       int    `json:"pid"`
	StartedAt int64  `json:"startedAt"` // Unix ms
	LastBeat  int64  `json:"lastBeat"`  // Unix ms
	ExitedAt  int64  `json:"exitedAt"`  // Unix ms; 0 when running
	Status    string `json:"status"`    // "running", "clean", "panic"
	Reason    string `json:"reason,omitempty"`
	Stack     string `json:"stack,omitempty"`
}

// writeRunning atomically writes the initial "running" breadcrumb for the
// current process. Best-effort: I/O errors are logged and never fatal.
func writeRunning(path string) {
	rec := exitRecord{
		Pid:       os.Getpid(),
		StartedAt: time.Now().UnixMilli(),
		LastBeat:  time.Now().UnixMilli(),
		Status:    "running",
	}
	if err := atomicWriteRecord(path, rec); err != nil {
		utils.Log("breadcrumb", fmt.Sprintf("writeRunning: %v", err))
	}
}

// beat updates lastBeat in place. Reads the existing record, updates the
// timestamp, and writes it back. Best-effort; skips silently on I/O error.
func beat(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return // no breadcrumb yet; nothing to beat
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return
	}
	if rec.Status != "running" {
		return // do not clobber a clean/panic record
	}
	rec.LastBeat = time.Now().UnixMilli()
	if err := atomicWriteRecord(path, rec); err != nil {
		utils.Log("breadcrumb", fmt.Sprintf("beat: %v", err))
	}
}

// writeClean atomically rewrites the breadcrumb with status "clean".
// Called from both graceful shutdown arms before srv.Stop().
func writeClean(path, reason string) {
	data, err := os.ReadFile(path)
	var rec exitRecord
	if err == nil {
		_ = json.Unmarshal(data, &rec)
	}
	rec.Status = "clean"
	rec.Reason = reason
	rec.ExitedAt = time.Now().UnixMilli()
	rec.LastBeat = time.Now().UnixMilli()
	if err := atomicWriteRecord(path, rec); err != nil {
		utils.Log("breadcrumb", fmt.Sprintf("writeClean: %v", err))
		return
	}
	utils.Log("breadcrumb", fmt.Sprintf("writeClean: reason=%s pid=%d", reason, rec.Pid))
}

// writePanic atomically writes a "panic" breadcrumb. Called from the
// top-level recover() in main() before re-panicking.
func writePanic(path string, reason string, stack string) {
	data, err := os.ReadFile(path)
	var rec exitRecord
	if err == nil {
		_ = json.Unmarshal(data, &rec)
	}
	rec.Status = "panic"
	rec.Reason = reason
	// Truncate stack to 4 KB to keep the file small.
	if len(stack) > 4096 {
		stack = stack[:4096] + " ...[truncated]"
	}
	rec.Stack = stack
	rec.ExitedAt = time.Now().UnixMilli()
	if err := atomicWriteRecord(path, rec); err != nil {
		utils.Log("breadcrumb", fmt.Sprintf("writePanic: %v", err))
		return
	}
	utils.Error("breadcrumb", fmt.Sprintf("writePanic: pid=%d reason=%s stack=%s", rec.Pid, reason, rec.Stack))
}

// logPriorExit reads any pre-existing breadcrumb file at path, classifies the
// prior process exit, and logs the result. Called once at engine startup, after
// the process-start banner.
//
// Classification:
//
//	absent         -> prior exit: none (first start or breadcrumb cleared)
//	status=clean   -> prior exit: clean reason=<...> prevPid=<...> uptime=<...>
//	status=running -> prior exit: UNCLEAN -- process died without shutdown
//	status=panic   -> prior exit: PANIC reason=<...> prevPid=<...>
func logPriorExit(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		utils.Log("breadcrumb", "prior exit: none (first start or breadcrumb cleared)")
		return
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		utils.Log("breadcrumb", fmt.Sprintf("prior exit: unreadable breadcrumb err=%v", err))
		return
	}

	switch rec.Status {
	case "clean":
		uptime := "unknown"
		if rec.StartedAt > 0 && rec.ExitedAt > 0 {
			uptime = fmt.Sprintf("%dms", rec.ExitedAt-rec.StartedAt)
		}
		utils.Log("breadcrumb", fmt.Sprintf(
			"prior exit: clean reason=%s prevPid=%d uptime=%s",
			rec.Reason, rec.Pid, uptime,
		))

	case "panic":
		utils.Error("breadcrumb", fmt.Sprintf(
			"prior exit: PANIC reason=%s prevPid=%d stack=%s",
			rec.Reason, rec.Pid, rec.Stack,
		))

	case "running":
		// Process died without a clean or panic record. Classify staleness.
		ageMs := time.Now().UnixMilli() - rec.LastBeat
		staleThresholdMs := int64(beatInterval/time.Millisecond) * 2

		// Secondary corroboration: if the prior PID is no longer alive, we
		// have strong confirmation of unclean exit (not just a stale beat).
		pidDead := !isProcessAliveByPID(rec.Pid)
		detail := ""
		if ageMs > staleThresholdMs {
			detail = fmt.Sprintf(" (breadcrumb stale by %dms)", ageMs-staleThresholdMs)
		}
		deadStr := ""
		if pidDead {
			deadStr = " pidConfirmed=dead"
		}
		utils.Error("breadcrumb", fmt.Sprintf(
			"prior exit: UNCLEAN -- process died without shutdown (SIGKILL/panic/parent death/OOM likely) prevPid=%d lastBeat=%dms ago%s%s",
			rec.Pid, ageMs, detail, deadStr,
		))

	default:
		utils.Log("breadcrumb", fmt.Sprintf("prior exit: unknown status=%q prevPid=%d", rec.Status, rec.Pid))
	}
}

// atomicWriteRecord marshals rec to JSON and atomically replaces path
// via a temp file + rename. fsync'd before rename so a crash mid-write
// leaves the old file intact rather than a partial write.
func atomicWriteRecord(path string, rec exitRecord) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}

	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("open tmp: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("write: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("sync: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// isProcessAliveByPID checks whether a process with the given PID is alive.
// Uses signal 0 on Unix (same approach as filelock.isProcessAlive) via the
// platform-specific signalZeroAlive helper.
func isProcessAliveByPID(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return signalZeroAlive(proc)
}

// captureStack returns the current goroutine stack as a string.
// Used in the panic recovery path.
func captureStack() string {
	buf := make([]byte, 16*1024)
	n := runtime.Stack(buf, false)
	s := string(buf[:n])
	// Trim the boilerplate first line to keep only the useful frames.
	if idx := strings.Index(s, "\n"); idx != -1 {
		s = s[idx+1:]
	}
	return s
}
