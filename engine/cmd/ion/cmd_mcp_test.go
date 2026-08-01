package main

// cmd_mcp_test.go — unit pins for the `ion mcp` argument surface.
//
// The subcommands themselves are thin wire clients (covered end to end by the
// engine's dispatch tests); what needs pinning here is the pure argument and
// output logic, which is where a CLI silently does the wrong thing:
//
//   - K=V flag parsing, because a malformed pair must be a usage error rather
//     than a dropped header the operator never learns was dropped.
//   - The multi-flag and bool-flag registrations, because a missing entry makes
//     `--header` swallow the following argument or `--no-browser` eat the
//     server name.

import (
	"os"
	"testing"
)

// TestParseKeyValueFlags_ParsesPairs pins the happy path, including a value
// that itself contains "=" (a base64 token, for instance) — splitting on the
// last separator instead of the first would corrupt it.
func TestParseKeyValueFlags_ParsesPairs(t *testing.T) {
	got := parseKeyValueFlags("header", []string{
		"Authorization=Bearer abc",
		"X-Team=platform",
		"X-Padded=dG9rZW4=",
	})
	want := map[string]string{
		"Authorization": "Bearer abc",
		"X-Team":        "platform",
		"X-Padded":      "dG9rZW4=",
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d pairs, want %d: %#v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("pair %q = %q, want %q", k, got[k], v)
		}
	}
}

// TestParseKeyValueFlags_EmptyIsNil pins that no flags yields nil rather than an
// empty map, so the command omits the field from the wire message entirely
// instead of sending an empty object.
func TestParseKeyValueFlags_EmptyIsNil(t *testing.T) {
	if got := parseKeyValueFlags("env", nil); got != nil {
		t.Errorf("no flags should yield nil, got %#v", got)
	}
	if got := parseKeyValueFlags("env", []string{}); got != nil {
		t.Errorf("empty flags should yield nil, got %#v", got)
	}
}

// TestParseKeyValueFlags_AllowsEmptyValue pins that "KEY=" is accepted: an
// empty environment variable is a legitimate thing to set.
func TestParseKeyValueFlags_AllowsEmptyValue(t *testing.T) {
	got := parseKeyValueFlags("env", []string{"EMPTY="})
	if v, ok := got["EMPTY"]; !ok || v != "" {
		t.Errorf("KEY= should parse to an empty value, got %#v", got)
	}
}

// TestMcpMultiFlagsRegistered pins that header/env/arg are repeatable.
//
// This is the registration that makes `--header A=1 --header B=2` collect both
// rather than keeping only the last. Without it a consumer's second header is
// silently discarded — the exact class of quiet data loss the flag exists to
// avoid.
func TestMcpMultiFlagsRegistered(t *testing.T) {
	for _, flag := range []string{"header", "env", "arg"} {
		if !multiFlags[flag] {
			t.Errorf("--%s must be registered in multiFlags to be repeatable", flag)
		}
	}
}

// TestNoBrowserIsABoolFlag pins that --no-browser does not consume the next
// argument. Unregistered, `ion mcp login --no-browser mobbin` would parse the
// server name as the flag's value and then fail with "requires a server name".
func TestNoBrowserIsABoolFlag(t *testing.T) {
	if !boolFlags["no-browser"] {
		t.Error("--no-browser must be registered in boolFlags so it does not consume the server name")
	}
}

// TestParseArgs_McpAddWithRepeatedFlags exercises the real parser on a full
// invocation, pinning that positional arguments and repeated flags coexist.
func TestParseArgs_McpAddWithRepeatedFlags(t *testing.T) {
	originalArgs := os.Args
	t.Cleanup(func() { os.Args = originalArgs })

	os.Args = []string{
		"ion", "mcp", "add", "internal", "https://mcp.example.test/mcp",
		"--header", "Authorization=Bearer t",
		"--header", "X-Team=platform",
		"--transport", "http",
	}

	command, flags, listFlags, positional := parseArgs()

	if command != "mcp" {
		t.Fatalf("command = %q, want mcp", command)
	}
	// parseArgs strips the command itself, so cmdMcp receives the subcommand
	// first — which is what its switch and its args[1:] slicing expect.
	wantPositional := []string{"add", "internal", "https://mcp.example.test/mcp"}
	if len(positional) != len(wantPositional) {
		t.Fatalf("positional = %#v, want %#v", positional, wantPositional)
	}
	for i := range wantPositional {
		if positional[i] != wantPositional[i] {
			t.Errorf("positional[%d] = %q, want %q", i, positional[i], wantPositional[i])
		}
	}
	if len(listFlags["header"]) != 2 {
		t.Errorf("repeated --header collected %d values, want 2: %#v", len(listFlags["header"]), listFlags["header"])
	}
	if flags["transport"] != "http" {
		t.Errorf("--transport = %q, want http", flags["transport"])
	}
}

// TestParseArgs_McpLoginNoBrowser pins that the bool flag leaves the server
// name in the positional list.
func TestParseArgs_McpLoginNoBrowser(t *testing.T) {
	originalArgs := os.Args
	t.Cleanup(func() { os.Args = originalArgs })

	os.Args = []string{"ion", "mcp", "login", "--no-browser", "mobbin"}

	_, flags, _, positional := parseArgs()

	if flags["no-browser"] != "true" {
		t.Errorf("--no-browser = %q, want true", flags["no-browser"])
	}
	found := false
	for _, p := range positional {
		if p == "mobbin" {
			found = true
		}
	}
	if !found {
		t.Errorf("server name was consumed by the bool flag; positional = %#v", positional)
	}
}

func TestYesNoAndAuthStateLabel(t *testing.T) {
	if yesNo(true) != "yes" || yesNo(false) != "no" {
		t.Error("yesNo must render yes/no")
	}
	if authStateLabel(true) != "yes" || authStateLabel(false) != "no" {
		t.Error("authStateLabel must render yes/no")
	}
}
