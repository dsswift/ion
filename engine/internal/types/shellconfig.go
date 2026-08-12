package types

import (
	"context"
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
//     (e.g. zsh -lc), so .zprofile is sourced for every command. Adding
//     InteractiveBash makes that an interactive login shell (zsh -ilc), which
//     additionally sources .zshrc.
//  2. It calls HydrateProcessPath() once at serve startup to merge the login
//     shell's PATH into the engine process environment via os.Setenv. This
//     ensures extension subprocesses and other engine-spawned children inherit
//     the full PATH even though launchd strips it to a minimal set. Hydration
//     always probes interactively FIRST, independent of InteractiveBash,
//     because PATH discovery wants the most complete answer available.
//
// The .zprofile / .zshrc distinction matters and is a common source of
// confusion: zsh sources .zprofile for login shells and .zshrc only for
// interactive ones. A login-only shell therefore sees a DIFFERENT PATH than the
// user's terminal, which is why hydration probes interactively first.
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
	// InteractiveBash, when true (and UseLoginShell is also true), runs each
	// Bash command through an INTERACTIVE login shell (-ilc) rather than a
	// login-only one (-lc).
	//
	// What this buys: zsh reads .zshrc only for interactive shells, so tools
	// that install themselves as shell FUNCTIONS rather than binaries become
	// callable. nvm is the canonical example -- `nvm use` cannot work from a
	// non-interactive shell because the function does not exist there.
	//
	// What it costs: interactive startup runs the user's full rc file for every
	// command. Prompt frameworks (starship), completion init (compinit), and any
	// rc-level diagnostics execute per call and may write to stdout/stderr,
	// which can contaminate tool output. It is also slower (~130 ms on a warm
	// macOS zsh).
	//
	// It is NOT needed for PATH. HydrateProcessPath already merges the
	// interactive login shell's PATH into the engine process at startup, and
	// every Bash subprocess inherits that through os.Environ(). Default false:
	// the engine ships the cheap, quiet behavior and lets an operator opt into
	// the richer one.
	InteractiveBash bool `json:"interactiveBash,omitempty"`
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
	//
	// InteractiveBash adds -i. That is not cosmetic: zsh reads .zprofile for
	// login shells but .zshrc ONLY for interactive ones, so the two modes source
	// different files and expose different rc-defined state. See the field
	// comment for the tradeoff.
	if s.InteractiveBash {
		return s.resolveShellPath(), []string{"-ilc", command}, true
	}
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
	s, _ := ctx.Value(shellConfigKey{}).(*ShellConfig) //nolint:errcheck // best-effort; failure not actionable here
	return s
}

// hydrationTimeout is the bounded deadline for the login-shell PATH discovery
// command. Matches the 3 s timeout used in desktop/src/main/cli-env.ts.
const hydrationTimeout = 3 * time.Second

// HydrationLogLevel classifies a PATH hydration diagnostic without coupling
// config types to a process-wide logging implementation.
type HydrationLogLevel string

const (
	HydrationLogLevelDebug HydrationLogLevel = "debug"
	HydrationLogLevelInfo  HydrationLogLevel = "info"
	HydrationLogLevelWarn  HydrationLogLevel = "warn"
)

// HydrationReporter receives PATH hydration diagnostics. The serve command
// adapts it to the engine's canonical structured logger.
type HydrationReporter func(level HydrationLogLevel, message string, fields map[string]any)

func reportHydration(reporter HydrationReporter, level HydrationLogLevel, message string, fields map[string]any) {
	if reporter != nil {
		reporter(level, message, fields)
	}
}

// hydrationProbe is one attempt at discovering the user's PATH.
type hydrationProbe struct {
	shell string
	args  []string
	// label identifies the probe in logs, so an operator can see which mode
	// actually produced the PATH they ended up with.
	label string
}

// buildHydrationProbes returns the PATH-discovery attempts in priority order.
//
// INTERACTIVE FIRST, and this ordering is the whole point. zsh sources
// .zprofile for login shells but .zshrc only for INTERACTIVE shells, and on a
// typical developer machine those two files hold different halves of PATH:
// .zprofile carries what /etc/paths.d and package managers install, while
// .zshrc carries what per-tool installers append (nvm, bun, cargo, and most
// `curl | sh` installers write there by default). A login-only probe therefore
// returns a PATH that looks plausible and is quietly missing entries, which is
// exactly the defect this ordering fixes.
//
// The login-only probe remains as a fallback for shells or environments where
// an interactive invocation fails (no tty, an rc file that exits non-zero under
// -i, a restricted shell).
//
// Separated from the exec call so the command construction is unit-testable
// without spawning a subprocess.
func (s *ShellConfig) buildHydrationProbes() []hydrationProbe {
	shell := s.resolveShellPath()
	return []hydrationProbe{
		{shell: shell, args: []string{"-ilc", "echo $PATH"}, label: "interactive-login"},
		{shell: shell, args: []string{"-lc", "echo $PATH"}, label: "login"},
	}
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

// pathEntrySet splits a PATH string into a set of non-empty entries.
func pathEntrySet(raw string) map[string]struct{} {
	set := make(map[string]struct{})
	for _, entry := range strings.Split(raw, ":") {
		if p := strings.TrimSpace(entry); p != "" {
			set[p] = struct{}{}
		}
	}
	return set
}

// discoveredNewEntries reports whether `discovered` contains at least one PATH
// entry that `current` does not.
//
// This is the probe's success criterion, and exit code 0 is NOT sufficient on
// its own. A probe can succeed, print a well-formed PATH, and still have
// discovered nothing -- that is precisely what happened on the desktop side,
// where a quoting bug meant an intermediate shell expanded $PATH before the
// target shell ever ran, so every probe "succeeded" while returning the
// caller's own PATH back to it. Requiring new entries turns that silent
// no-op into a visible, logged rejection.
func discoveredNewEntries(current, discovered string) bool {
	currentSet := pathEntrySet(current)
	for entry := range pathEntrySet(discovered) {
		if _, known := currentSet[entry]; !known {
			return true
		}
	}
	return false
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
// Probes run in the order given by buildHydrationProbes (interactive-login
// first, see that function for why) and the first one that discovers at least
// one new PATH entry wins. A probe that errors, returns nothing, or returns a
// PATH already covered by the current one is reported and skipped.
//
// HydrateProcessPath is nil-safe and a no-op when UseLoginShell is false.
// Call it once at serve startup, before any session or extension subprocess
// spawns. Total hydration failure reports a WARN and leaves PATH unchanged -- it
// does not fail startup, because a stripped PATH is a degraded engine while a
// refused startup is no engine at all. Diagnostics include PATH entry counts,
// never raw PATH values.
func (s *ShellConfig) HydrateProcessPath(reporter HydrationReporter) {
	if s == nil {
		reportHydration(reporter, HydrationLogLevelDebug, "process path hydration skipped", map[string]any{"reason": "shell_config_nil"})
		return
	}
	if !s.UseLoginShell {
		reportHydration(reporter, HydrationLogLevelDebug, "process path hydration skipped", map[string]any{"reason": "login_shell_disabled"})
		return
	}
	if runtime.GOOS == "windows" {
		reportHydration(reporter, HydrationLogLevelDebug, "process path hydration skipped", map[string]any{"reason": "windows_platform"})
		return
	}

	pathBefore := os.Getenv("PATH")
	probes := s.buildHydrationProbes()
	reportHydration(reporter, HydrationLogLevelInfo, "hydrating process path", map[string]any{
		"count": len(probes),
	})

	for _, probe := range probes {
		ctx, cancel := context.WithTimeout(context.Background(), hydrationTimeout)
		cmd := exec.CommandContext(ctx, probe.shell, probe.args...)
		// Only stdout is captured. An interactive shell routinely writes rc
		// diagnostics and prompt-framework output to stderr; that noise says
		// nothing about whether the PATH we read is good.
		out, err := cmd.Output()
		cancel()

		if err != nil {
			reportHydration(reporter, HydrationLogLevelWarn, "process path probe failed", map[string]any{
				"probe": probe.label, "shell": probe.shell, "error": err.Error(),
			})
			continue
		}

		discovered := strings.TrimRight(string(out), "\n\r")
		if !discoveredNewEntries(pathBefore, discovered) {
			reportHydration(reporter, HydrationLogLevelWarn, "process path probe discovered nothing new", map[string]any{
				"probe": probe.label, "shell": probe.shell, "reason": "no_new_entries",
			})
			continue
		}

		merged := mergePathEntries(pathBefore, discovered)
		if err := os.Setenv("PATH", merged); err != nil {
			reportHydration(reporter, HydrationLogLevelWarn, "process path update failed", map[string]any{
				"error": err.Error(),
			})
			return
		}

		reportHydration(reporter, HydrationLogLevelInfo, "process path hydrated", map[string]any{
			"probe": probe.label,
			"shell": probe.shell,
			"count": len(pathEntrySet(merged)),
		})
		return
	}

	reportHydration(reporter, HydrationLogLevelWarn, "process path hydration failed", map[string]any{
		"count": len(probes),
	})
}
