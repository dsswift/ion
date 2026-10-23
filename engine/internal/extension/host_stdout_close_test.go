package extension

import (
	"bufio"
	"os"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runReaderUntilClosed starts readLoop on a pipe, marks the host dead when
// dead is true, then closes the read end under the blocked Scan the way
// cmd.Wait does during dispose, and returns the engine log lines.
func runReaderUntilClosed(t *testing.T, dead bool) []map[string]any {
	t.Helper()
	dir := t.TempDir()
	utils.SetLevel(utils.LevelDebug)
	utils.ConfigureLogging(&types.LoggingConfig{LogDir: dir, OutputMode: "file"})
	t.Cleanup(func() {
		utils.SetLevel(utils.LevelInfo)
		utils.ConfigureLogging(&types.LoggingConfig{LogDir: os.TempDir(), OutputMode: "file"})
	})

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() }) //nolint:errcheck // test teardown

	h := NewHost()
	h.SetNameForTest("closer")
	h.readerWg.Add(1)
	go h.readLoop(bufio.NewScanner(r))

	// Let the reader block in Scan before the pipe is closed under it.
	time.Sleep(50 * time.Millisecond)
	if dead {
		h.MarkDeadForTest()
	}
	if err := r.Close(); err != nil {
		t.Fatalf("close read end: %v", err)
	}

	done := make(chan struct{})
	go func() { h.readerWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("readLoop did not return after its stdout was closed")
	}
	return readStructuredLogLines(t, dir)
}

// A stdout closed under a host that dispose already marked dead is the
// teardown itself: logged at debug, never as a scanner error.
func TestReadLoopTreatsDisposeCloseAsTeardown(t *testing.T) {
	lines := runReaderUntilClosed(t, true)
	if obj := findStructuredLog(lines, "stdout scanner error ()"); obj != nil {
		t.Fatalf("dispose's close was logged as a scanner error: %v", obj)
	}
	obj := findStructuredLog(lines, "stdout closed by dispose ()")
	if obj == nil {
		t.Fatal("dispose's close left no debug line")
	}
	if lvl, _ := obj["level"].(string); lvl != "DEBUG" {
		t.Fatalf("level = %q, want DEBUG", lvl)
	}
}

// The same close under a live host is not something dispose did, so it
// stays an error.
func TestReadLoopReportsACloseUnderALiveHost(t *testing.T) {
	lines := runReaderUntilClosed(t, false)
	obj := findStructuredLog(lines, "stdout scanner error ()")
	if obj == nil {
		t.Fatal("a close under a live host was not reported")
	}
	if lvl, _ := obj["level"].(string); lvl != "ERROR" {
		t.Fatalf("level = %q, want ERROR", lvl)
	}
}

func TestStdoutClosedByDispose(t *testing.T) {
	closed := &os.PathError{Op: "read", Path: "|0", Err: os.ErrClosed}
	cases := []struct {
		dead bool
		err  error
		want bool
	}{
		{true, closed, true},
		{false, closed, false},
		{true, bufio.ErrTooLong, false},
		{true, os.ErrDeadlineExceeded, false},
	}
	for _, c := range cases {
		if got := stdoutClosedByDispose(c.dead, c.err); got != c.want {
			t.Errorf("stdoutClosedByDispose(%v, %v) = %v, want %v", c.dead, c.err, got, c.want)
		}
	}
}
