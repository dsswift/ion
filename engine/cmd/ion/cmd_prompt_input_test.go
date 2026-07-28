package main

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// pipeWithContent returns a read end of a pipe pre-loaded with content and
// closed, so io.ReadAll on it terminates. A pipe is deliberately not a
// character device, which is what makes it stand in for a redirected stdin.
func pipeWithContent(t *testing.T, content string) *os.File {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	t.Cleanup(func() { r.Close() }) //nolint:errcheck // test cleanup
	go func() {
		defer w.Close() //nolint:errcheck // writer close signals EOF
		if content == "" {
			return
		}
		if _, err := w.WriteString(content); err != nil {
			// The reader side asserts on the resulting empty read; the
			// test cannot t.Fatal from a non-test goroutine.
			t.Logf("pipe write failed: %v", err)
		}
	}()
	return r
}

func TestResolvePromptTextPositionalJoin(t *testing.T) {
	got, err := resolvePromptText([]string{"explain", "the", "builder", "pattern"}, pipeWithContent(t, "ignored stdin"))
	if err != nil {
		t.Fatalf("resolvePromptText: %v", err)
	}
	if want := "explain the builder pattern"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestResolvePromptTextStdinLargerThanArgvLimit is the regression test for the
// release-notification failure. MAX_ARG_STRLEN caps a single argv entry at
// 128 KiB, so a 200 KB prompt cannot be passed as an argument at all; before
// stdin was accepted there was no way to send it. The size here is the point of
// the test, not incidental.
func TestResolvePromptTextStdinLargerThanArgvLimit(t *testing.T) {
	body := strings.Repeat("ion release context line\n", 8000) // ~200 KB
	if len(body) < 128*1024 {
		t.Fatalf("fixture is %d bytes; must exceed the 128 KiB argv limit to be meaningful", len(body))
	}

	got, err := resolvePromptText(nil, pipeWithContent(t, body))
	if err != nil {
		t.Fatalf("resolvePromptText: %v", err)
	}
	if want := strings.TrimRight(body, "\r\n"); got != want {
		t.Errorf("got %d bytes, want %d bytes", len(got), len(want))
	}
}

func TestResolvePromptTextExplicitDashReadsStdin(t *testing.T) {
	got, err := resolvePromptText([]string{"-"}, pipeWithContent(t, "piped prompt body\n"))
	if err != nil {
		t.Fatalf("resolvePromptText: %v", err)
	}
	if want := "piped prompt body"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestResolvePromptTextTrimsOnlyTrailingNewline(t *testing.T) {
	got, err := resolvePromptText(nil, pipeWithContent(t, "  leading and trailing spaces kept  \n"))
	if err != nil {
		t.Fatalf("resolvePromptText: %v", err)
	}
	if want := "  leading and trailing spaces kept  "; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestResolvePromptTextEmptyStdin pins the user-visible outcome of the
// no-text case. A TTY stdin cannot be synthesized portably, but an empty
// stdin reaches the same "prompt text required" error the terminal branch
// returns, which is the behaviour callers depend on (exit 1 with that message).
func TestResolvePromptTextEmptyStdin(t *testing.T) {
	if _, err := resolvePromptText(nil, pipeWithContent(t, "")); !errors.Is(err, errPromptTextRequired) {
		t.Errorf("got error %v, want errPromptTextRequired", err)
	}
}

func TestResolvePromptTextEmptyPositional(t *testing.T) {
	if _, err := resolvePromptText([]string{""}, pipeWithContent(t, "")); !errors.Is(err, errPromptTextRequired) {
		t.Errorf("got error %v, want errPromptTextRequired", err)
	}
}
