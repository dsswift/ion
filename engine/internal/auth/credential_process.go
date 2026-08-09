package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	credProcessDefaultTimeout = 30 * time.Second
	credProcessMinTimeout     = 1 * time.Second
	credProcessMaxTimeout     = 120 * time.Second
	credProcessMaxOutput      = 1 << 20 // 1 MiB
)

// CredentialProcessConfig configures an external credential process.
type CredentialProcessConfig struct {
	// Command is the executable and arguments to run. The first element is
	// the program; remaining elements are arguments. Must not be empty.
	Command []string `json:"command"`
	// TimeoutMs is the maximum execution time in milliseconds. Clamped to
	// [1000, 120000]; zero selects the 30s default.
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
}

type credentialProcessRequest struct {
	Version  int    `json:"version"`
	Scope    string `json:"scope,omitempty"`
	Audience string `json:"audience,omitempty"`
}

type boundedBuffer struct {
	buf      bytes.Buffer
	limit    int
	exceeded bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	original := len(p)
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		b.exceeded = true
		return original, nil
	}
	if len(p) > remaining {
		b.exceeded = true
		p = p[:remaining]
	}
	_, _ = b.buf.Write(p) // bytes.Buffer never returns a write error.
	return original, nil
}

func (b *boundedBuffer) Bytes() []byte  { return b.buf.Bytes() }
func (b *boundedBuffer) Len() int       { return b.buf.Len() }
func (b *boundedBuffer) String() string { return b.buf.String() }

// credentialProcessOutput is the expected JSON output from the credential
// process, modeled after the AWS credential_process spec.
type credentialProcessOutput struct {
	Version         int    `json:"Version"`
	AccessToken     string `json:"AccessToken"`
	ExpirationISO   string `json:"Expiration,omitempty"`
	ExpirationEpoch int64  `json:"ExpirationEpoch,omitempty"`
}

// CredentialProcessSource acquires bearer tokens by executing an external
// process that writes a JSON credential to stdout. The process is expected
// to handle its own authentication (e.g. reading a keyfile, calling a
// vault, refreshing a grant). The engine treats it as a black box: run,
// capture stdout, parse the JSON, return the token.
type CredentialProcessSource struct {
	cfg     CredentialProcessConfig
	timeout time.Duration
}

// CredentialProcessOption configures a test-injectable override.
type CredentialProcessOption func(*CredentialProcessSource)

// NewCredentialProcessSource creates a credential-process token source.
func NewCredentialProcessSource(cfg CredentialProcessConfig, opts ...CredentialProcessOption) (*CredentialProcessSource, error) {
	if len(cfg.Command) == 0 {
		return nil, fmt.Errorf("credential process: command must not be empty")
	}

	if !filepath.IsAbs(cfg.Command[0]) {
		return nil, fmt.Errorf("credential process: executable path must be absolute")
	}

	timeout := credProcessDefaultTimeout
	if cfg.TimeoutMs > 0 {
		timeout = time.Duration(cfg.TimeoutMs) * time.Millisecond
	}
	if timeout < credProcessMinTimeout {
		timeout = credProcessMinTimeout
	}
	if timeout > credProcessMaxTimeout {
		timeout = credProcessMaxTimeout
	}

	s := &CredentialProcessSource{
		cfg:     cfg,
		timeout: timeout,
	}
	for _, o := range opts {
		o(s)
	}
	return s, nil
}

// Acquire implements TokenSource. resource and scope are passed to the
// process as environment variables ION_TOKEN_RESOURCE and ION_TOKEN_SCOPE.
func (s *CredentialProcessSource) Acquire(ctx context.Context, resource, scope string) (string, time.Time, error) {
	cmdStr := redactCommand(s.cfg.Command)

	utils.LogWithFields(utils.LevelDebug, "auth.credprocess", "executing credential process", map[string]any{
		"command":  cmdStr,
		"timeout":  s.timeout.String(),
		"resource": resource,
	})

	execCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, s.cfg.Command[0], s.cfg.Command[1:]...) //nolint:gosec // operator-configured command
	// Kill the entire process group on Unix so a helper that launches children
	// cannot keep stdout/stderr pipes open after CommandContext kills only its
	// immediate shell. Platform helper is a no-op where process groups differ.
	configureCredentialProcess(cmd)
	requestJSON, err := json.Marshal(credentialProcessRequest{Version: 1, Scope: resource, Audience: scope})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("credential process: encode request: %w", err)
	}
	cmd.Stdin = bytes.NewReader(requestJSON)
	var stdout, stderr boundedBuffer
	stdout.limit = credProcessMaxOutput
	stderr.limit = 4096
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Env = buildCredProcessEnv(resource, scope)

	if err := runCredentialProcess(execCtx, cmd); err != nil {
		stderrStr := truncateStderr(stderr.String())
		utils.LogWithFields(utils.LevelError, "auth.credprocess", "credential process failed", map[string]any{
			"command": cmdStr,
			"error":   err.Error(),
			"stderr":  stderrStr,
		})
		if execCtx.Err() != nil {
			return "", time.Time{}, fmt.Errorf("credential process: timed out after %s: %w", s.timeout, err)
		}
		return "", time.Time{}, fmt.Errorf("credential process: exit error: %w (stderr: %s)", err, stderrStr)
	}

	if stdout.exceeded {
		return "", time.Time{}, fmt.Errorf("credential process: output exceeds %d bytes", credProcessMaxOutput)
	}

	var out credentialProcessOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		utils.LogWithFields(utils.LevelError, "auth.credprocess", "credential process output parse failed", map[string]any{
			"command": cmdStr,
			"error":   err.Error(),
		})
		return "", time.Time{}, fmt.Errorf("credential process: parse output: %w", err)
	}

	if out.Version != 1 {
		return "", time.Time{}, fmt.Errorf("credential process: unsupported output version %d (expected 1)", out.Version)
	}
	if out.AccessToken == "" {
		return "", time.Time{}, fmt.Errorf("credential process: output has empty AccessToken")
	}

	expiresAt := parseCredProcessExpiry(out)
	if expiresAt.IsZero() {
		return "", time.Time{}, fmt.Errorf("credential process: output requires Expiration or ExpirationEpoch")
	}

	utils.LogWithFields(utils.LevelInfo, "auth.credprocess", "credential process succeeded", map[string]any{
		"command":    cmdStr,
		"expires_at": expiresAt,
		"resource":   resource,
	})

	return out.AccessToken, expiresAt, nil
}

// parseCredProcessExpiry extracts the expiry from the credential process
// output. Prefers ExpirationEpoch (unix seconds), falls back to
// ExpirationISO (RFC 3339). Returns zero time if neither is set.
func parseCredProcessExpiry(out credentialProcessOutput) time.Time {
	if out.ExpirationEpoch > 0 {
		return time.Unix(out.ExpirationEpoch, 0)
	}
	if out.ExpirationISO != "" {
		if t, err := time.Parse(time.RFC3339, out.ExpirationISO); err == nil {
			return t
		}
	}
	return time.Time{}
}

// buildCredProcessEnv creates a clean environment slice with only the
// token request parameters. The process inherits no parent environment
// to prevent credential leakage through env vars.
func buildCredProcessEnv(resource, scope string) []string {
	env := []string{
		"ION_TOKEN_RESOURCE=" + resource,
		"ION_TOKEN_SCOPE=" + scope,
	}
	if path := os.Getenv("PATH"); path != "" {
		env = append(env, "PATH="+path)
	}
	return env
}

// redactCommand returns a log-safe representation of the command. The
// program name is shown; arguments are counted but not shown (they may
// contain secrets like vault paths or key IDs).
func redactCommand(cmd []string) string {
	if len(cmd) == 0 {
		return "<empty>"
	}
	if len(cmd) == 1 {
		return cmd[0]
	}
	return fmt.Sprintf("%s [%d args]", cmd[0], len(cmd)-1)
}

// truncateStderr returns a bounded, single-line version of stderr for
// log inclusion.
func truncateStderr(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\n", " | ")
	if len(s) > 200 {
		return s[:200] + "...[truncated]"
	}
	return s
}
