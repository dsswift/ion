package auth

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// These tests exercise CredentialProcessSource against a real child process,
// because the property under test is real subprocess behavior: env vars
// reaching the child, exit codes, stderr capture, timeouts, and output-size
// limits. A shell script (#!/bin/sh) can express all of that on POSIX, but
// Windows cannot execute one directly regardless of shebang -- CreateProcess
// refuses a .sh file outright ("%1 is not a valid Win32 application"), so a
// script fixture leaves the entire credential_process mechanism untested
// there. Instead these use the standard Go test-helper-process pattern (the
// same one net/http and os/exec use in their own suites): the test binary
// re-execs itself with -test.run=TestHelperProcess, and TestHelperProcess
// reads a mode argument after "--" to decide what to print/exit/sleep. That
// binary is directly executable on every platform Go supports.
func helperCommand(t *testing.T, mode string) []string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return []string{exe, "-test.run=TestHelperProcess", "--", mode}
}

// TestHelperProcess is not a real test. It only does anything when re-exec'd
// by helperCommand with a "--" marker and a mode argument; a normal `go test`
// invocation has neither, so it returns immediately as a no-op. See
// helperCommand's doc comment for why this pattern exists.
func TestHelperProcess(t *testing.T) {
	mode := helperProcessMode()
	if mode == "" {
		return
	}
	switch mode {
	case "success":
		fmt.Println(`{"Version":1,"AccessToken":"proc-token-abc","ExpirationEpoch":1800000000}`)
	case "iso8601":
		fmt.Println(`{"Version":1,"AccessToken":"iso-token","Expiration":"2030-01-01T00:00:00Z"}`)
	case "no-expiry":
		fmt.Println(`{"Version":1,"AccessToken":"no-expiry-token"}`)
	case "env-check":
		if os.Getenv("ION_TOKEN_RESOURCE") == "test-resource" && os.Getenv("ION_TOKEN_SCOPE") == "test-scope" {
			fmt.Println(`{"Version":1,"AccessToken":"env-ok","ExpirationEpoch":1800000000}`)
		} else {
			fmt.Fprintln(os.Stderr, "bad env")
			os.Exit(1)
		}
	case "wrong-version":
		fmt.Println(`{"Version":2,"AccessToken":"token"}`)
	case "empty-token":
		fmt.Println(`{"Version":1,"AccessToken":""}`)
	case "process-fail":
		fmt.Fprintln(os.Stderr, "something went wrong")
		os.Exit(1)
	case "sleep30":
		time.Sleep(30 * time.Second)
	case "invalid-json":
		fmt.Println("not json at all")
	case "oversized":
		buf := make([]byte, 1048577)
		for i := range buf {
			buf[i] = 'A'
		}
		os.Stdout.Write(buf) //nolint:errcheck // best-effort write in a test helper subprocess
	case "ok":
		fmt.Println("ok")
	}
	os.Exit(0)
}

// helperProcessMode returns the mode argument after a "--" marker in
// os.Args, or "" when this process was not invoked by helperCommand (i.e.
// this is the top-level `go test` run, not a re-exec'd helper).
func helperProcessMode() string {
	for i, arg := range os.Args {
		if arg == "--" && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

func TestCredentialProcessSource_Acquire_Success(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command:   helperCommand(t, "success"),
		TimeoutMs: 5000,
	})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}

	token, expiresAt, err := src.Acquire(context.Background(), "my-resource", "my-scope")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "proc-token-abc" {
		t.Fatalf("expected proc-token-abc, got %q", token)
	}
	if expiresAt.Unix() != 1800000000 {
		t.Fatalf("expected epoch 1800000000, got %d", expiresAt.Unix())
	}
}

func TestCredentialProcessSource_Acquire_ISO8601Expiry(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "iso8601"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, expiresAt, err := src.Acquire(context.Background(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if expiresAt.Year() != 2030 {
		t.Fatalf("expected 2030, got %d", expiresAt.Year())
	}
}

func TestCredentialProcessSource_Acquire_NoExpiry(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "no-expiry"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = src.Acquire(context.Background(), "", "")
	if err == nil || !strings.Contains(err.Error(), "requires Expiration") {
		t.Fatalf("expected required-expiry error, got %v", err)
	}
}

func TestCredentialProcessSource_Acquire_ReceivesEnvVars(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "env-check"),
	})
	if err != nil {
		t.Fatal(err)
	}

	token, _, err := src.Acquire(context.Background(), "test-resource", "test-scope")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "env-ok" {
		t.Fatalf("expected env-ok, got %q", token)
	}
}

func TestCredentialProcessSource_Acquire_WrongVersion(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "wrong-version"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for Version != 1")
	}
	if !strings.Contains(err.Error(), "unsupported output version 2") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCredentialProcessSource_Acquire_EmptyToken(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "empty-token"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for empty AccessToken")
	}
	if !strings.Contains(err.Error(), "empty AccessToken") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCredentialProcessSource_Acquire_ProcessFails(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "process-fail"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for failed process")
	}
	if !strings.Contains(err.Error(), "exit error") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(err.Error(), "something went wrong") {
		t.Fatalf("expected stderr in error, got: %v", err)
	}
}

func TestCredentialProcessSource_Acquire_Timeout(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command:   helperCommand(t, "sleep30"),
		TimeoutMs: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	_, _, err = src.Acquire(context.Background(), "", "")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("unexpected error: %v", err)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("timeout took too long: %v", elapsed)
	}
}

func TestCredentialProcessSource_Acquire_InvalidJSON(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "invalid-json"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected parse error")
	}
	if !strings.Contains(err.Error(), "parse output") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCredentialProcessSource_Acquire_OutputExceedsLimit(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: helperCommand(t, "oversized"),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for oversized output")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCredentialProcessSource_EmptyCommand(t *testing.T) {
	_, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: nil,
	})
	if err == nil {
		t.Fatal("expected error for empty command")
	}
	if !strings.Contains(err.Error(), "command must not be empty") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCredentialProcessSource_RelativePath(t *testing.T) {
	_, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{"relative-binary"},
	})
	if err == nil {
		t.Fatal("expected error for relative path")
	}
	if !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCredentialProcessSource_TimeoutClamping(t *testing.T) {
	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command:   helperCommand(t, "ok"),
		TimeoutMs: 500,
	})
	if err != nil {
		t.Fatal(err)
	}
	if src.timeout != credProcessMinTimeout {
		t.Fatalf("expected min timeout %v, got %v", credProcessMinTimeout, src.timeout)
	}

	src, err = NewCredentialProcessSource(CredentialProcessConfig{
		Command:   helperCommand(t, "ok"),
		TimeoutMs: 200000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if src.timeout != credProcessMaxTimeout {
		t.Fatalf("expected max timeout %v, got %v", credProcessMaxTimeout, src.timeout)
	}
}

func TestRedactCommand(t *testing.T) {
	if redactCommand(nil) != "<empty>" {
		t.Fatal("expected <empty>")
	}
	if redactCommand([]string{"/usr/bin/fetch-token"}) != "/usr/bin/fetch-token" {
		t.Fatal("expected program path only")
	}
	result := redactCommand([]string{"/usr/bin/vault", "read", "secret/api-key"})
	if !strings.Contains(result, "/usr/bin/vault") {
		t.Fatal("expected program name")
	}
	if !strings.Contains(result, "2 args") {
		t.Fatal("expected arg count")
	}
	if strings.Contains(result, "secret") {
		t.Fatal("arguments should be redacted")
	}
}

func TestTruncateStderr(t *testing.T) {
	if truncateStderr("  hello\nworld  ") != "hello | world" {
		t.Fatalf("unexpected: %q", truncateStderr("  hello\nworld  "))
	}
	long := strings.Repeat("x", 300)
	result := truncateStderr(long)
	if !strings.Contains(result, "[truncated]") {
		t.Fatal("expected truncation")
	}
}

func TestParseCredProcessExpiry(t *testing.T) {
	t.Run("epoch takes precedence", func(t *testing.T) {
		out := credentialProcessOutput{
			ExpirationEpoch: 1800000000,
			ExpirationISO:   "2030-01-01T00:00:00Z",
		}
		result := parseCredProcessExpiry(out)
		if result.Unix() != 1800000000 {
			t.Fatalf("expected epoch, got %v", result)
		}
	})

	t.Run("falls back to ISO", func(t *testing.T) {
		out := credentialProcessOutput{
			ExpirationISO: "2030-06-15T12:00:00Z",
		}
		result := parseCredProcessExpiry(out)
		if result.Year() != 2030 || result.Month() != 6 {
			t.Fatalf("expected 2030-06, got %v", result)
		}
	})

	t.Run("zero when neither set", func(t *testing.T) {
		result := parseCredProcessExpiry(credentialProcessOutput{})
		if !result.IsZero() {
			t.Fatalf("expected zero time, got %v", result)
		}
	})
}

func TestBoundedBuffer(t *testing.T) {
	b := &boundedBuffer{limit: 10}
	n, err := b.Write([]byte("hello"))
	if err != nil || n != 5 {
		t.Fatalf("first write: n=%d err=%v", n, err)
	}
	if b.exceeded {
		t.Fatal("should not be exceeded")
	}

	n, err = b.Write([]byte("world!"))
	if err != nil {
		t.Fatalf("second write: err=%v", err)
	}
	if n != 6 {
		t.Fatalf("expected original len reported, got %d", n)
	}
	if !b.exceeded {
		t.Fatal("should be exceeded after overflow")
	}
	if b.Len() != 10 {
		t.Fatalf("expected 10 bytes stored, got %d", b.Len())
	}
}
