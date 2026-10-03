package utils

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// readLogGenerations returns every line of engine.jsonl and its rotated
// generations in dir, keyed by file name.
func readLogGenerations(t *testing.T, dir string) map[string][]string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "engine.jsonl*"))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.Base(path)] = splitNonEmptyLines(string(data))
	}
	return out
}

func logMessages(t *testing.T, lines []string) []string {
	t.Helper()
	var msgs []string
	for _, line := range lines {
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			t.Fatalf("torn or invalid log line %q: %v", line, err)
		}
		msg, _ := obj["msg"].(string) //nolint:errcheck // absent msg compares as ""
		msgs = append(msgs, msg)
	}
	return msgs
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// A writer whose file another process rotated away moves to the new live
// file instead of appending to the archived generation.
func TestLoggerFollowsFileRotatedByAnotherProcess(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)
	live := filepath.Join(dir, "engine.jsonl")

	Info("follow", "before the other process rotates")
	// What another process's rotation does to this one's file.
	if err := os.Rename(live, live+".1"); err != nil {
		t.Fatal(err)
	}
	logMu.Lock()
	logFollowCheckedAt = time.Time{} // the follow interval has passed
	logMu.Unlock()
	Info("follow", "after the other process rotated")

	files := readLogGenerations(t, dir)
	liveMsgs := logMessages(t, files["engine.jsonl"])
	if !contains(liveMsgs, "after the other process rotated") {
		t.Fatalf("new line did not reach the live file: %v", liveMsgs)
	}
	if !contains(liveMsgs, "log file reopened") {
		t.Fatalf("reopen was not recorded: %v", liveMsgs)
	}
	archived := logMessages(t, files["engine.jsonl.1"])
	if contains(archived, "after the other process rotated") {
		t.Fatal("line was appended to the rotated-away file")
	}
}

// A writer whose file was deleted recreates it.
func TestLoggerRecreatesDeletedFile(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)
	live := filepath.Join(dir, "engine.jsonl")

	Info("follow", "first line")
	if err := os.Remove(live); err != nil {
		t.Fatal(err)
	}
	logMu.Lock()
	logFollowCheckedAt = time.Time{}
	logMu.Unlock()
	Info("follow", "after delete")

	msgs := logMessages(t, readLogGenerations(t, dir)["engine.jsonl"])
	if !contains(msgs, "after delete") {
		t.Fatalf("live file not recreated: %v", msgs)
	}
}

// Rotation is decided by the live file's real size, which counts what other
// processes wrote, not only this process's own writes.
func TestLoggerRotatesOnSizeWrittenByOthers(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)
	logMu.Lock()
	maxLogSize = 4096
	logMu.Unlock()
	t.Cleanup(func() {
		logMu.Lock()
		maxLogSize = 20 * 1024 * 1024
		logMu.Unlock()
	})
	live := filepath.Join(dir, "engine.jsonl")

	Info("size", "own line")
	// Another process appends past the cap.
	other, err := os.OpenFile(live, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.WriteString(`{"msg":"` + strings.Repeat("x", 8192) + "\"}\n"); err != nil {
		t.Fatal(err)
	}
	other.Close() //nolint:errcheck // test writer
	logMu.Lock()
	logFollowCheckedAt = time.Time{}
	logMu.Unlock()
	Info("size", "next own line")

	files := readLogGenerations(t, dir)
	if len(files["engine.jsonl.1"]) == 0 {
		t.Fatal("live file over the cap was not rotated")
	}
	if !contains(logMessages(t, files["engine.jsonl"]), "log file rotated") {
		t.Fatalf("rotation was not recorded: %v", files["engine.jsonl"])
	}
}

const (
	logWriterDirEnv = "ION_TEST_LOG_WRITER_DIR"
	logWriterIDEnv  = "ION_TEST_LOG_WRITER_ID"
	logWriterLines  = 2500
)

// TestLogWriterProcess is not a test on its own. It is the child process for
// TestLoggerConcurrentProcessesShareOneLog, which re-runs the test binary
// with the environment below set.
func TestLogWriterProcess(t *testing.T) {
	dir := os.Getenv(logWriterDirEnv)
	if dir == "" {
		t.Skip("helper process for TestLoggerConcurrentProcessesShareOneLog")
	}
	id := os.Getenv(logWriterIDEnv)
	resetLoggerForTest(t, dir)
	logMu.Lock()
	maxLogSize = 64 * 1024
	maxLogFiles = 1000
	logMu.Unlock()
	for i := 0; i < logWriterLines; i++ {
		Info("writer", fmt.Sprintf("writer=%s seq=%d %s", id, i, strings.Repeat("p", 120)))
		if i%100 == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
}

// Two processes write and rotate one log at the same time. Every line from
// both lands exactly once and intact, and rotation happened. On Windows this
// also proves rotation can rename a file another process holds open.
func TestLoggerConcurrentProcessesShareOneLog(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns processes")
	}
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	writers := []string{"a", "b"}
	var wg sync.WaitGroup
	errs := make([]error, len(writers))
	outputs := make([][]byte, len(writers))
	for i, id := range writers {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			cmd := exec.Command(exe, "-test.run=^TestLogWriterProcess$", "-test.count=1")
			cmd.Env = append(os.Environ(), logWriterDirEnv+"="+dir, logWriterIDEnv+"="+id)
			outputs[i], errs[i] = cmd.CombinedOutput()
		}(i, id)
	}
	wg.Wait()
	for i := range writers {
		if errs[i] != nil {
			t.Fatalf("writer %s failed: %v\n%s", writers[i], errs[i], outputs[i])
		}
	}

	files := readLogGenerations(t, dir)
	if len(files["engine.jsonl.1"]) == 0 {
		t.Fatalf("no rotation happened; files: %d", len(files))
	}
	seen := map[string]int{}
	for name, lines := range files {
		for _, msg := range logMessages(t, lines) {
			if strings.HasPrefix(msg, "log rotation failed") {
				t.Errorf("%s records a failed rotation", name)
			}
			if !strings.HasPrefix(msg, "writer=") {
				continue
			}
			seen[strings.Fields(msg)[0]+" "+strings.Fields(msg)[1]]++
		}
	}
	for _, id := range writers {
		for i := 0; i < logWriterLines; i++ {
			key := "writer=" + id + " seq=" + strconv.Itoa(i)
			if seen[key] != 1 {
				t.Fatalf("%s appears %d times across generations, want 1", key, seen[key])
			}
		}
	}
}
