package main

import (
	"os"
	"testing"
)

// Regression tests for the argument parser's command resolution.
//
// The defect: parseArgs resolved ANY leading `--flag` to the "serve" command,
// so `ion --version` booted the daemon path. cmdServe creates ~/.ion, logs an
// "=== engine process start ===" line, writes an exit breadcrumb, loads config,
// and reconciles plugins BEFORE the file lock refuses a second instance. On a
// machine with a healthy daemon, every version probe therefore emitted a start
// line and a "prior exit: UNCLEAN" breadcrumb — a log signature identical to a
// real crash loop, which is exactly how it was misdiagnosed. cos2's Makefile
// shells out to `ion version` on every build, so the noise was continuous.
//
// The invariant these pin: a question about the binary never resolves to a
// command that starts the engine.

func withArgs(t *testing.T, argv ...string) (command string, positional []string) {
	t.Helper()
	saved := os.Args
	t.Cleanup(func() { os.Args = saved })
	os.Args = append([]string{"ion"}, argv...)
	cmd, _, _, pos := parseArgs()
	return cmd, pos
}

// TestInfoFlagsNeverResolveToServe is the core regression test. Each of these
// spellings must resolve to an informational command; resolving to "serve"
// means a version probe boots the engine again.
func TestInfoFlagsNeverResolveToServe(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"--version"}, "version"},
		{[]string{"-v"}, "version"},
		{[]string{"version"}, "version"},
		{[]string{"--help"}, "help"},
		{[]string{"-h"}, "help"},
		{[]string{"help"}, "help"},
	} {
		t.Run(tc.argv[0], func(t *testing.T) {
			got, _ := withArgs(t, tc.argv...)
			if got == "serve" {
				t.Fatalf("%q resolved to %q — a question about the binary must never start the engine", tc.argv[0], got)
			}
			if got != tc.want {
				t.Errorf("%q resolved to %q, want %q", tc.argv[0], got, tc.want)
			}
		})
	}
}

// TestServeDefaultsPreserved pins that narrowing the flag branch did not break
// the legitimate default. A bare invocation, and an invocation carrying only
// daemon options, must still serve.
func TestServeDefaultsPreserved(t *testing.T) {
	for _, argv := range [][]string{
		{},                           // bare `ion`
		{"--model", "claude-opus-5"}, // options with no command
		{"--no-extensions"},          // bool flag with no command
	} {
		label := "bare"
		if len(argv) > 0 {
			label = argv[0]
		}
		t.Run(label, func(t *testing.T) {
			if got, _ := withArgs(t, argv...); got != "serve" {
				t.Errorf("%v resolved to %q, want serve", argv, got)
			}
		})
	}
	// An explicit `serve` still works.
	if got, _ := withArgs(t, "serve"); got != "serve" {
		t.Errorf("explicit serve resolved to %q", got)
	}
}

// TestInfoFlagsDoNotShadowSubcommandArguments pins that the info-flag lookup is
// scoped to the FIRST argument only. `--version` appearing later is an option
// to a real command, not a command of its own — otherwise adding this fix would
// silently hijack any subcommand that accepts a `--version` value.
func TestInfoFlagsDoNotShadowSubcommandArguments(t *testing.T) {
	cmd, _ := withArgs(t, "plugin", "install", "--version", "1.2.3")
	if cmd != "plugin" {
		t.Errorf("command = %q, want plugin; a later --version must stay an option", cmd)
	}
}

// TestBareVersionWordKeepsPositionals guards against the arg-slice bookkeeping
// slipping when a command is consumed from the info-flag branch: the remaining
// arguments must still be parsed normally rather than dropped or double-counted.
func TestBareVersionWordKeepsPositionals(t *testing.T) {
	cmd, pos := withArgs(t, "--version", "extra")
	if cmd != "version" {
		t.Fatalf("command = %q, want version", cmd)
	}
	if len(pos) != 1 || pos[0] != "extra" {
		t.Errorf("positional = %v, want [extra] — the consumed flag must not eat the rest of argv", pos)
	}
}
