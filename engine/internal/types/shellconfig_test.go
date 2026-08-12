package types

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

// TestShellConfigResolveInteractiveBash pins the InteractiveBash opt-in: it
// upgrades the login shell to an INTERACTIVE login shell (-ilc), which is what
// makes rc-defined shell functions (nvm and friends) callable from a Bash tool
// call.
//
// The "unset" arm is the more important of the two. InteractiveBash defaults to
// false and must stay that way for every operator who has not asked for it:
// interactive startup runs the full rc file per command and can write prompt or
// completion noise into tool output. A regression that flipped the default would
// be silent and would degrade every consumer, so it is pinned explicitly.
func TestShellConfigResolveInteractiveBash(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only; Windows uses PowerShell")
	}

	t.Run("enabled yields -ilc", func(t *testing.T) {
		cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/usr/bin/fakesh", InteractiveBash: true}
		_, args, login := cfg.Resolve("echo hi")
		if len(args) != 2 || args[0] != "-ilc" || args[1] != "echo hi" {
			t.Errorf("args = %v, want [-ilc echo hi]", args)
		}
		if !login {
			t.Errorf("loginShell = false, want true")
		}
	})

	t.Run("unset keeps -lc (default unchanged)", func(t *testing.T) {
		cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/usr/bin/fakesh"}
		_, args, _ := cfg.Resolve("echo hi")
		if len(args) != 2 || args[0] != "-lc" {
			t.Errorf("args = %v, want [-lc echo hi]", args)
		}
	})

	t.Run("ignored when login shell is off", func(t *testing.T) {
		// InteractiveBash is a modifier on login-shell mode, not an independent
		// switch: without UseLoginShell there is no rc sourcing to make
		// interactive, so the historical bash -c default must survive.
		cfg := &ShellConfig{UseLoginShell: false, InteractiveBash: true}
		shell, args, login := cfg.Resolve("echo hi")
		if shell != "bash" || len(args) != 2 || args[0] != "-c" {
			t.Errorf("shell/args = %q %v, want bash [-c echo hi]", shell, args)
		}
		if login {
			t.Errorf("loginShell = true, want false")
		}
	})
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

// TestMergePathEntries_OrderPreservedNoDuplicates verifies the core merge
// logic: current entries come first, discovered entries are appended
// order-preserving, and duplicates are dropped regardless of which side
// introduces them.
func TestMergePathEntries_OrderPreservedNoDuplicates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PATH merging uses colon separator; Windows uses semicolons")
	}

	cases := []struct {
		name       string
		current    string
		discovered string
		want       []string // ordered expected segments
	}{
		{
			name:       "current retained, new entries appended",
			current:    "/usr/bin:/bin",
			discovered: "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
			// /usr/bin is already in current; should not appear twice.
			want: []string{"/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"},
		},
		{
			name:       "empty current takes all discovered",
			current:    "",
			discovered: "/opt/homebrew/bin:/usr/bin",
			want:       []string{"/opt/homebrew/bin", "/usr/bin"},
		},
		{
			name:       "empty discovered preserves current",
			current:    "/usr/bin:/bin",
			discovered: "",
			want:       []string{"/usr/bin", "/bin"},
		},
		{
			name:       "both empty yields empty",
			current:    "",
			discovered: "",
			want:       []string{},
		},
		{
			name:       "all duplicates: current entries dominate",
			current:    "/usr/bin:/bin",
			discovered: "/usr/bin:/bin",
			want:       []string{"/usr/bin", "/bin"},
		},
		{
			name:       "trailing colon in discovered ignored",
			current:    "/usr/bin",
			discovered: "/opt/homebrew/bin:",
			want:       []string{"/usr/bin", "/opt/homebrew/bin"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mergePathEntries(tc.current, tc.discovered)
			var gotParts []string
			if got != "" {
				gotParts = strings.Split(got, ":")
			} else {
				gotParts = []string{}
			}

			if len(gotParts) != len(tc.want) {
				t.Fatalf("mergePathEntries(%q, %q) = %q (%d parts), want %v (%d parts)",
					tc.current, tc.discovered, got, len(gotParts), tc.want, len(tc.want))
			}
			for i, w := range tc.want {
				if gotParts[i] != w {
					t.Errorf("part[%d] = %q, want %q", i, gotParts[i], w)
				}
			}
		})
	}
}

// TestBuildHydrationCommand verifies that buildHydrationCommand produces the
// correct shell and arguments without spawning a subprocess. This pins the
// command shape the exec path will use.
func TestBuildHydrationProbes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/bin/zsh"}
	probes := cfg.buildHydrationProbes()

	if len(probes) != 2 {
		t.Fatalf("got %d probes, want 2 (interactive-login, login)", len(probes))
	}

	// Interactive FIRST. This ordering is the fix for the defect where PATH
	// entries written by per-tool installers into .zshrc were invisible to the
	// engine, because a login-only shell never sources that file.
	if probes[0].label != "interactive-login" {
		t.Errorf("probes[0].label = %q, want interactive-login", probes[0].label)
	}
	if len(probes[0].args) != 2 || probes[0].args[0] != "-ilc" || probes[0].args[1] != "echo $PATH" {
		t.Errorf("probes[0].args = %v, want [-ilc echo $PATH]", probes[0].args)
	}
	if probes[1].label != "login" {
		t.Errorf("probes[1].label = %q, want login", probes[1].label)
	}
	if len(probes[1].args) != 2 || probes[1].args[0] != "-lc" {
		t.Errorf("probes[1].args = %v, want [-lc echo $PATH]", probes[1].args)
	}
	for i, p := range probes {
		if p.shell != "/bin/zsh" {
			t.Errorf("probes[%d].shell = %q, want /bin/zsh", i, p.shell)
		}
	}

	// Hydration probes interactively regardless of InteractiveBash: that flag
	// governs per-command execution, not PATH discovery. Discovery always wants
	// the most complete answer available.
	cfgNoInteractive := &ShellConfig{UseLoginShell: true, ShellPath: "/bin/zsh", InteractiveBash: false}
	if got := cfgNoInteractive.buildHydrationProbes(); got[0].args[0] != "-ilc" {
		t.Errorf("hydration must probe interactively even when InteractiveBash is false; got %v", got[0].args)
	}

	// Verify $SHELL is used when ShellPath is unset.
	t.Setenv("SHELL", "/bin/bash")
	cfg2 := &ShellConfig{UseLoginShell: true}
	if got := cfg2.buildHydrationProbes()[0].shell; got != "/bin/bash" {
		t.Errorf("shell = %q, want /bin/bash (from $SHELL)", got)
	}
}

// TestDiscoveredNewEntries pins the probe success criterion.
//
// Exit code 0 is not sufficient evidence that a probe worked. The desktop's
// equivalent probe returned the caller's own PATH for years while "succeeding"
// on every attempt, because a quoting bug let an intermediate shell expand
// $PATH before the target shell ran. Requiring at least one genuinely new entry
// is what converts that silent no-op into a logged rejection.
func TestDiscoveredNewEntries(t *testing.T) {
	cases := []struct {
		name       string
		current    string
		discovered string
		want       bool
	}{
		{"adds one entry", "/usr/bin:/bin", "/usr/bin:/bin:/opt/homebrew/bin", true},
		{"identical", "/usr/bin:/bin", "/usr/bin:/bin", false},
		{"reordered but same set", "/usr/bin:/bin", "/bin:/usr/bin", false},
		{"subset", "/usr/bin:/bin:/sbin", "/usr/bin", false},
		{"empty discovery", "/usr/bin:/bin", "", false},
		{"everything new", "", "/opt/homebrew/bin", true},
		{"whitespace only", "/usr/bin", "  :  ", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := discoveredNewEntries(tc.current, tc.discovered); got != tc.want {
				t.Errorf("discoveredNewEntries(%q, %q) = %v, want %v",
					tc.current, tc.discovered, got, tc.want)
			}
		})
	}
}

// TestHydrateProcessPath_RedactsRawPathFromDiagnostics pins the diagnostics
// boundary: callers receive enough metadata to reconstruct the failed attempt,
// but never a raw PATH that can reveal user-specific installation locations.
func TestHydrateProcessPath_RedactsRawPathFromDiagnostics(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	const privatePath = "/private/operator/bin:/usr/bin"
	t.Setenv("PATH", privatePath)
	var reports []struct {
		level   HydrationLogLevel
		message string
		fields  map[string]any
	}
	reporter := func(level HydrationLogLevel, message string, fields map[string]any) {
		reports = append(reports, struct {
			level   HydrationLogLevel
			message string
			fields  map[string]any
		}{level: level, message: message, fields: fields})
	}

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/nonexistent/shell-binary"}
	cfg.HydrateProcessPath(reporter)

	if len(reports) == 0 {
		t.Fatal("expected hydration diagnostics")
	}
	for _, report := range reports {
		if strings.Contains(report.message, privatePath) || strings.Contains(fmt.Sprint(report.fields), privatePath) {
			t.Fatalf("hydration diagnostic leaks raw PATH: %+v", report)
		}
	}
	last := reports[len(reports)-1]
	if last.level != HydrationLogLevelWarn || last.message != "process path hydration failed" {
		t.Errorf("last report = (%q, %q), want warning process path hydration failed", last.level, last.message)
	}
}

// TestHydrateProcessPath_SourcesInteractiveRcFile is the regression test for
// the second PATH bug: a login-only probe never reads .zshrc.
//
// It writes a .zshrc into a temp HOME that exports a uniquely-named directory
// onto PATH, then asserts hydration picks it up. zsh sources .zshrc ONLY for
// interactive shells, so this fails against a `-lc` probe and passes against
// `-ilc` -- which is exactly the behavioral difference under test.
//
// ZDOTDIR (not HOME) is what zsh consults for user rc files, so the test sets
// both: HOME for correctness of the sandbox, ZDOTDIR for the mechanism.
func TestHydrateProcessPath_SourcesInteractiveRcFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}
	if _, err := os.Stat("/bin/zsh"); err != nil {
		t.Skip("/bin/zsh not present (Linux CI); interactive-rc behavior is zsh-specific")
	}

	home := t.TempDir()
	marker := filepath.Join(home, "interactive-only-bin")

	// .zshrc is read by INTERACTIVE shells only. If hydration probes with -lc,
	// this line never executes and the marker never reaches PATH.
	rc := "export PATH=\"" + marker + ":$PATH\"\n"
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(rc), 0o600); err != nil {
		t.Fatalf("write .zshrc: %v", err)
	}

	before := os.Getenv("PATH")
	t.Cleanup(func() { _ = os.Setenv("PATH", before) })
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", home)

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/bin/zsh"}
	cfg.HydrateProcessPath(nil)

	if got := os.Getenv("PATH"); !strings.Contains(got, marker) {
		t.Errorf("hydrated PATH is missing the .zshrc-only entry %q.\n"+
			"This means hydration used a login-only shell, which does not source .zshrc.\nPATH = %q",
			marker, got)
	}
}

// TestHydrateProcessPath_LeavesPathAloneWhenProbesFail confirms the fail-open
// contract: a shell that cannot run must not damage the existing PATH. A
// degraded PATH is a recoverable annoyance; a destroyed one breaks every
// subsequent subprocess the engine spawns.
func TestHydrateProcessPath_LeavesPathAloneWhenProbesFail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	before := os.Getenv("PATH")
	t.Cleanup(func() { _ = os.Setenv("PATH", before) })

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/nonexistent/shell-binary"}
	cfg.HydrateProcessPath(nil)

	if got := os.Getenv("PATH"); got != before {
		t.Errorf("PATH changed after total probe failure:\n got %q\nwant %q", got, before)
	}
}

// TestHydrateProcessPath_NoOpWhenNil confirms that calling HydrateProcessPath
// on a nil receiver leaves PATH unchanged.
func TestHydrateProcessPath_NoOpWhenNil(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	before := os.Getenv("PATH")
	t.Cleanup(func() { _ = os.Setenv("PATH", before) })

	var s *ShellConfig
	s.HydrateProcessPath(nil) // must not panic

	if got := os.Getenv("PATH"); got != before {
		t.Errorf("PATH changed: got %q, want %q", got, before)
	}
}

// TestHydrateProcessPath_NoOpWhenLoginShellFalse confirms that
// HydrateProcessPath is a no-op when UseLoginShell is false.
func TestHydrateProcessPath_NoOpWhenLoginShellFalse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	before := os.Getenv("PATH")
	t.Cleanup(func() { _ = os.Setenv("PATH", before) })

	s := &ShellConfig{UseLoginShell: false}
	s.HydrateProcessPath(nil)

	if got := os.Getenv("PATH"); got != before {
		t.Errorf("PATH changed: got %q, want %q", got, before)
	}
}

// TestHydrateProcessPath_MergesLoginShellPath is an integration-style test
// that actually spawns the user's shell. It is skipped when UseLoginShell
// behavior cannot be verified (e.g., CI without a proper login shell).
// The test confirms the post-hydration PATH is a superset of the pre-hydration
// PATH and that the current entries are still present and come first.
func TestHydrateProcessPath_MergesLoginShellPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	before := os.Getenv("PATH")
	t.Cleanup(func() { _ = os.Setenv("PATH", before) })

	cfg := &ShellConfig{UseLoginShell: true}
	cfg.HydrateProcessPath(nil)

	after := os.Getenv("PATH")

	// After hydration, every entry that was in PATH before must still be
	// present and must appear before any newly-added entries. The merge
	// dedupes on first occurrence, so the order expectation is computed
	// over the deduplicated original entries -- a raw PATH with duplicate
	// entries (common in inherited shell environments) would otherwise
	// trip the assertion on the duplicate's second occurrence.
	if before != "" {
		rawBefore := strings.Split(before, ":")
		beforeParts := make([]string, 0, len(rawBefore))
		seen := make(map[string]struct{}, len(rawBefore))
		for _, p := range rawBefore {
			if _, dup := seen[p]; dup || p == "" {
				continue
			}
			seen[p] = struct{}{}
			beforeParts = append(beforeParts, p)
		}
		afterParts := strings.Split(after, ":")

		afterIdx := make(map[string]int, len(afterParts))
		for i, p := range afterParts {
			if _, exists := afterIdx[p]; !exists {
				afterIdx[p] = i
			}
		}

		prevIdx := -1
		for _, p := range beforeParts {
			idx, ok := afterIdx[p]
			if !ok {
				t.Errorf("entry %q from original PATH is missing from merged PATH", p)
				continue
			}
			if idx <= prevIdx {
				t.Errorf("entry %q from original PATH is not in original order (got idx %d, prev %d)", p, idx, prevIdx)
			}
			prevIdx = idx
		}
	}
}
