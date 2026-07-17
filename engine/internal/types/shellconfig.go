package types

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ShellConfig controls how the engine's Bash tool selects the shell used to
// execute commands, and -- when UseLoginShell is true -- also hydrates the
// engine process PATH once at serve startup so every subprocess the engine
// spawns (extension node hosts, esbuild, npm, child_process calls inside
// extensions) sees the user's full login-shell PATH rather than the stripped
// launchd environment (/usr/bin:/bin:/usr/sbin:/sbin).
//
// It mirrors the nil-safe, context-plumbed design of TimeoutsConfig: the
// struct is omitted entirely from engine.json by default (the
// EngineRuntimeConfig.Shell pointer is nil), and every accessor accepts a nil
// receiver and returns the compiled default behavior.
//
// Default behavior (nil ShellConfig or UseLoginShell == false): the Bash tool
// runs commands through a non-login, non-interactive shell -- bash -c on
// POSIX, PowerShell -NoProfile -Command on Windows -- which sources no shell
// rc files. This is the historical behavior and is preserved unchanged.
//
// When UseLoginShell is true, the engine does two things:
//  1. It runs each Bash command through the user's actual login shell
//     (e.g. zsh -lc), so .zprofile/.zshrc are sourced for every command.
//  2. It calls HydrateProcessPath() once at serve startup to merge the login
//     shell's PATH into the engine process environment via os.Setenv. This
//     ensures extension subprocesses and other engine-spawned children inherit
//     the full PATH even though launchd strips it to a minimal set.
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

// hydrationTimeout is the bounded deadline for the login-shell PATH discovery
// command. Matches the 3 s timeout used in desktop/src/main/cli-env.ts.
const hydrationTimeout = 3 * time.Second

// buildHydrationCommand returns the shell binary and argument list for the
// PATH-discovery invocation. Separated from the exec call so the command
// construction can be unit-tested without spawning a subprocess.
func (s *ShellConfig) buildHydrationCommand() (shell string, args []string) {
	return s.resolveShellPath(), []string{"-lc", "echo $PATH"}
}

// mergePathEntries builds a merged, order-preserving, deduplicated PATH string.
// Current process entries come first (they are trusted and already working),
// then any discovered entries not already in the set are appended. This mirrors
// the appendPathEntries shape in desktop/src/main/cli-env.ts:5-13.
func mergePathEntries(current, discovered string) string {
	ordered := make([]string, 0, 32)
	seen := make(map[string]struct{})

	appendEntries := func(raw string) {
		for _, entry := range strings.Split(raw, ":") {
			p := strings.TrimSpace(entry)
			if p == "" {
				continue
			}
			if _, dup := seen[p]; dup {
				continue
			}
			seen[p] = struct{}{}
			ordered = append(ordered, p)
		}
	}

	appendEntries(current)
	appendEntries(discovered)
	return strings.Join(ordered, ":")
}

// HydrateProcessPath discovers the user's login-shell PATH and merges it into
// the engine process environment via os.Setenv so that every subprocess the
// engine spawns (extension node hosts, esbuild, npm, child_process calls inside
// extensions) inherits the full PATH.
//
// The engine runs as a launchd agent whose PATH is stripped to
// /usr/bin:/bin:/usr/sbin:/sbin. Extension subprocesses and tool child_process
// calls (e.g. ops-sync's `ion prompt`) inherit this stripped PATH via
// os.Environ(), causing "command not found" failures for tools installed in
// /opt/homebrew/bin, /usr/local/bin, and similar locations.
//
// HydrateProcessPath is nil-safe and a no-op when UseLoginShell is false.
// Call it once at serve startup, before any session or extension subprocess
// spawns. Hydration failure (shell error, timeout) logs a WARN and leaves
// PATH unchanged -- it does not fail startup.
func (s *ShellConfig) HydrateProcessPath() {
	// No-op: nil receiver.
	if s == nil {
		slog.Debug("engine-grounding: HydrateProcessPath no-op: ShellConfig is nil")
		return
	}
	// No-op: login-shell disabled.
	if !s.UseLoginShell {
		slog.Debug("engine-grounding: HydrateProcessPath no-op: useLoginShell is false")
		return
	}
	// No-op on Windows: login-shell semantics don't apply.
	if runtime.GOOS == "windows" {
		slog.Debug("engine-grounding: HydrateProcessPath no-op: Windows platform")
		return
	}

	shell, args := s.buildHydrationCommand()
	pathBefore := os.Getenv("PATH")
	slog.Info("engine-grounding: hydrating process PATH",
		"shell", shell,
		"pathBefore", pathBefore,
	)

	ctx, cancel := context.WithTimeout(context.Background(), hydrationTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, shell, args...)
	out, err := cmd.Output()
	if err != nil {
		slog.Warn("engine-grounding: PATH hydration failed; leaving PATH unchanged",
			"shell", shell,
			"error", err.Error(),
		)
		return
	}

	discovered := strings.TrimRight(string(out), "\n\r")
	merged := mergePathEntries(pathBefore, discovered)

	if err := os.Setenv("PATH", merged); err != nil {
		slog.Warn("engine-grounding: os.Setenv(PATH) failed; leaving PATH unchanged",
			"error", err.Error(),
		)
		return
	}

	slog.Info("engine-grounding: process PATH hydrated",
		"shell", shell,
		"pathAfter", merged,
	)
}
