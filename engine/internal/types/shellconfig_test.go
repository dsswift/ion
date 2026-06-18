package types

import (
	"context"
	"runtime"
	"testing"
)

// TestShellConfigResolveDefault pins the default (non-login) behavior: a nil
// ShellConfig or UseLoginShell == false yields bash -c on POSIX. This is the
// regression guard for the historical behavior.
func TestShellConfigResolveDefault(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only; Windows uses PowerShell")
	}

	cases := []struct {
		name string
		cfg  *ShellConfig
	}{
		{"nil config", nil},
		{"login disabled", &ShellConfig{UseLoginShell: false}},
		{"login disabled with shell path", &ShellConfig{UseLoginShell: false, ShellPath: "/bin/zsh"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			shell, args, login := tc.cfg.Resolve("echo hi")
			if shell != "bash" {
				t.Errorf("shell = %q, want bash", shell)
			}
			if len(args) != 2 || args[0] != "-c" || args[1] != "echo hi" {
				t.Errorf("args = %v, want [-c echo hi]", args)
			}
			if login {
				t.Errorf("loginShell = true, want false")
			}
		})
	}
}

// TestShellConfigResolveLoginShell pins login-shell mode: UseLoginShell true
// produces a login shell invocation (-lc). ShellPath, when set, is used
// verbatim so the test is hermetic and does not depend on the developer's
// real $SHELL.
func TestShellConfigResolveLoginShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only; Windows uses PowerShell")
	}

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/usr/bin/fakesh"}
	shell, args, login := cfg.Resolve("echo hi")
	if shell != "/usr/bin/fakesh" {
		t.Errorf("shell = %q, want /usr/bin/fakesh", shell)
	}
	if len(args) != 2 || args[0] != "-lc" || args[1] != "echo hi" {
		t.Errorf("args = %v, want [-lc echo hi]", args)
	}
	if !login {
		t.Errorf("loginShell = false, want true")
	}
}

// TestShellConfigResolveShellPathOrder pins the resolution order when no
// explicit ShellPath is given: $SHELL takes precedence over the /bin/zsh and
// /bin/bash fallbacks.
func TestShellConfigResolveShellPathOrder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only; Windows uses PowerShell")
	}

	t.Setenv("SHELL", "/custom/path/myshell")
	cfg := &ShellConfig{UseLoginShell: true}
	shell, _, _ := cfg.Resolve("echo hi")
	if shell != "/custom/path/myshell" {
		t.Errorf("shell = %q, want /custom/path/myshell (from $SHELL)", shell)
	}

	// Explicit ShellPath wins over $SHELL.
	cfg.ShellPath = "/explicit/shell"
	shell, _, _ = cfg.Resolve("echo hi")
	if shell != "/explicit/shell" {
		t.Errorf("shell = %q, want /explicit/shell (explicit ShellPath wins)", shell)
	}
}

// TestShellConfigContextRoundTrip pins the context plumbing: a ShellConfig
// stored via WithShellConfig is retrieved by ShellConfigFrom, and an absent
// config yields nil (which Resolve handles nil-safely).
func TestShellConfigContextRoundTrip(t *testing.T) {
	ctx := context.Background()
	if got := ShellConfigFrom(ctx); got != nil {
		t.Errorf("ShellConfigFrom(empty) = %v, want nil", got)
	}

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/bin/zsh"}
	ctx = WithShellConfig(ctx, cfg)
	got := ShellConfigFrom(ctx)
	if got != cfg {
		t.Errorf("ShellConfigFrom = %v, want %v", got, cfg)
	}
}
