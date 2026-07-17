package types

import (
	"context"
	"os"
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
func TestBuildHydrationCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell semantics are POSIX-only")
	}

	cfg := &ShellConfig{UseLoginShell: true, ShellPath: "/bin/zsh"}
	shell, args := cfg.buildHydrationCommand()

	if shell != "/bin/zsh" {
		t.Errorf("shell = %q, want /bin/zsh", shell)
	}
	if len(args) != 2 || args[0] != "-lc" || args[1] != "echo $PATH" {
		t.Errorf("args = %v, want [-lc echo $PATH]", args)
	}

	// Verify $SHELL is used when ShellPath is unset.
	t.Setenv("SHELL", "/bin/bash")
	cfg2 := &ShellConfig{UseLoginShell: true}
	shell2, args2 := cfg2.buildHydrationCommand()
	if shell2 != "/bin/bash" {
		t.Errorf("shell = %q, want /bin/bash (from $SHELL)", shell2)
	}
	if len(args2) != 2 || args2[0] != "-lc" || args2[1] != "echo $PATH" {
		t.Errorf("args = %v, want [-lc echo $PATH]", args2)
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
	s.HydrateProcessPath() // must not panic

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
	s.HydrateProcessPath()

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
	cfg.HydrateProcessPath()

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
