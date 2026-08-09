package auth

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCredentialProcessSource_Acquire_Success(t *testing.T) {
	script := writeTestScript(t, `#!/bin/sh
echo '{"Version":1,"AccessToken":"proc-token-abc","ExpirationEpoch":1800000000}'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command:   []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo '{"Version":1,"AccessToken":"iso-token","Expiration":"2030-01-01T00:00:00Z"}'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo '{"Version":1,"AccessToken":"no-expiry-token"}'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
if [ "$ION_TOKEN_RESOURCE" = "test-resource" ] && [ "$ION_TOKEN_SCOPE" = "test-scope" ]; then
  echo '{"Version":1,"AccessToken":"env-ok","ExpirationEpoch":1800000000}'
else
  echo "bad env" >&2
  exit 1
fi
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo '{"Version":2,"AccessToken":"token"}'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo '{"Version":1,"AccessToken":""}'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo "something went wrong" >&2
exit 1
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
exec sleep 30
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command:   []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo 'not json at all'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\0' 'A'
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command: []string{script},
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
	script := writeTestScript(t, `#!/bin/sh
echo ok
`)

	src, err := NewCredentialProcessSource(CredentialProcessConfig{
		Command:   []string{script},
		TimeoutMs: 500,
	})
	if err != nil {
		t.Fatal(err)
	}
	if src.timeout != credProcessMinTimeout {
		t.Fatalf("expected min timeout %v, got %v", credProcessMinTimeout, src.timeout)
	}

	src, err = NewCredentialProcessSource(CredentialProcessConfig{
		Command:   []string{script},
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

func writeTestScript(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "script.sh")
	if err := os.WriteFile(path, []byte(content), 0700); err != nil {
		t.Fatalf("write test script: %v", err)
	}
	return path
}
