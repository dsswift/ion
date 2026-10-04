//go:build windows

package watcher

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// The goroutine that opens a source can later park its thread in a blocking
// pipe read, as the extension host's stdio readers do. Close must still
// cancel the pending change read and return.
func TestRecursiveSource_CloseWhileOpenerThreadBlocksOnPipe(t *testing.T) {
	root := t.TempDir()
	pipeR, pipeW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer pipeW.Close() //nolint:errcheck // test cleanup
	defer pipeR.Close() //nolint:errcheck // test cleanup

	opened := make(chan eventSource, 1)
	openErr := make(chan error, 1)
	go func() {
		// Keep the opener on one thread so the blocking read lands on the
		// same thread that opened the source.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		src, err := newRecursiveSource(root)
		if err != nil {
			openErr <- err
			return
		}
		opened <- src
		buf := make([]byte, 1)
		_, _ = pipeR.Read(buf) //nolint:errcheck // blocks until the test closes the pipe
	}()

	var src eventSource
	select {
	case src = <-opened:
	case err := <-openErr:
		t.Fatalf("newRecursiveSource: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("newRecursiveSource did not return")
	}
	// Let the opener's thread enter the pipe read.
	time.Sleep(200 * time.Millisecond)

	closed := make(chan error, 1)
	go func() { closed <- src.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Errorf("Close: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close hung while the opener's thread was blocked on a pipe read")
	}
}
