package main

import (
	"os"
	"testing"
)

// TestParseArgs_SupervisedFlag pins that `ion serve --supervised` sets
// flags["supervised"] = "true", which cmdServe reads to decide whether to
// hide its own console (windows) or log the flag as ignored (elsewhere).
func TestParseArgs_SupervisedFlag(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"ion", "serve", "--supervised"}

	command, flags, _, _ := parseArgs()
	if command != "serve" {
		t.Fatalf("command = %q, want serve", command)
	}
	if flags["supervised"] != "true" {
		t.Errorf("flags[supervised] = %q, want true", flags["supervised"])
	}
}

// TestParseArgs_ServeWithoutSupervised pins the default: no --supervised
// flag leaves the key absent, not merely empty.
func TestParseArgs_ServeWithoutSupervised(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"ion", "serve"}

	command, flags, _, _ := parseArgs()
	if command != "serve" {
		t.Fatalf("command = %q, want serve", command)
	}
	if _, ok := flags["supervised"]; ok {
		t.Errorf("flags[supervised] should be absent, got %q", flags["supervised"])
	}
}
