package types

import (
	"context"
	"os"
	"runtime"
)

// ShellConfig controls how the engine's Bash tool selects the shell used to
// execute commands. It mirrors the nil-safe, context-plumbed design of
// TimeoutsConfig: the struct is omitted entirely from engine.json by default
// (the EngineRuntimeConfig.Shell pointer is nil), and every accessor accepts a
// nil receiver and returns the compiled default behavior.
//
// Default behavior (nil ShellConfig or UseLoginShell == false): the Bash tool
// runs commands through a non-login, non-interactive shell -- bash -c on
// POSIX, PowerShell -NoProfile -Command on Windows -- which sources no shell
// rc files. This is the historical behavior and is preserved unchanged.
//
// When UseLoginShell is true, the engine runs each Bash command through the
// user's actual login shell (e.g. zsh -lc), so .zprofile/.zshrc are sourced
// for every command. This picks up the user's PATH, aliases, shell functions,
// and rc-exported environment that a non-login shell never sees. It re-sources
// per command, so it is robust to mid-session environment changes.
//
// Login-shell semantics apply to POSIX platforms only. On Windows the
// PowerShell branch is unchanged: there is no analogous "login shell" concept,
// so UseLoginShell has no effect there.
type ShellConfig struct {
	// UseLoginShell, when true, runs Bash commands through the user's login
	// shell (sourcing rc files) instead of the default non-login bash -c.
	UseLoginShell bool `json:"useLoginShell,omitempty"`
	// ShellPath optionally pins the shell binary to use when UseLoginShell is
	// true. Empty means auto-resolve: $SHELL, else /bin/zsh, else /bin/bash.
	ShellPath string `json:"shellPath,omitempty"`
}

// Resolve returns the shell binary and argument list to execute the given
// command, honoring the login-shell preference. It is nil-safe: a nil receiver
// or UseLoginShell == false returns the historical default for the current
// platform (bash -c on POSIX, PowerShell on Windows).
//
// The second return value reports whether login-shell mode was selected, so
// callers can log which branch was taken.
func (s *ShellConfig) Resolve(command string) (shell string, args []string, loginShell bool) {
	// Windows always uses the PowerShell default; login-shell does not apply.
	if runtime.GOOS == "windows" {
		return "powershell", []string{"-NoProfile", "-Command", command}, false
	}

	// Default (nil config or login-shell disabled): non-login bash -c.
	if s == nil || !s.UseLoginShell {
		return "bash", []string{"-c", command}, false
	}

	// Login-shell mode: resolve the user's shell and run it as a login shell
	// so rc files are sourced. -l (login) + -c (command string).
	return s.resolveShellPath(), []string{"-lc", command}, true
}

// resolveShellPath picks the shell binary for login-shell mode. Resolution
// order: explicit ShellPath > $SHELL > /bin/zsh > /bin/bash. It is nil-safe.
func (s *ShellConfig) resolveShellPath() string {
	if s != nil && s.ShellPath != "" {
		return s.ShellPath
	}
	if env := os.Getenv("SHELL"); env != "" {
		return env
	}
	if _, err := os.Stat("/bin/zsh"); err == nil {
		return "/bin/zsh"
	}
	return "/bin/bash"
}

type shellConfigKey struct{}

// WithShellConfig stores a ShellConfig in the context for the Bash tool to
// read without changing the Execute signature. Mirrors WithTimeouts.
func WithShellConfig(ctx context.Context, s *ShellConfig) context.Context {
	return context.WithValue(ctx, shellConfigKey{}, s)
}

// ShellConfigFrom retrieves a ShellConfig from the context. Returns nil if none
// is set; the Resolve accessor is nil-safe, so callers can use the result
// directly.
func ShellConfigFrom(ctx context.Context) *ShellConfig {
	s, _ := ctx.Value(shellConfigKey{}).(*ShellConfig)
	return s
}
