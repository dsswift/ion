package types

import (
	"strings"
	"testing"
	"time"
)

func TestExtensionHostsValidate(t *testing.T) {
	good := &ExtensionHostsConfig{
		Extensions: []string{"/ext/cos2"},
		Session:    HeadlessSessionConfig{WorkingDirectory: "/work"},
	}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid block rejected: %v", err)
	}
	var none *ExtensionHostsConfig
	if err := none.Validate(); err != nil {
		t.Fatal("nil block is valid")
	}
	cases := []struct {
		name string
		cfg  ExtensionHostsConfig
		want string
	}{
		{"no extensions", ExtensionHostsConfig{Session: HeadlessSessionConfig{WorkingDirectory: "/w"}}, "extensions is empty"},
		{"empty path", ExtensionHostsConfig{Extensions: []string{""}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}}, "extensions[0] is empty"},
		{"no working dir", ExtensionHostsConfig{Extensions: []string{"/e"}}, "workingDirectory is required"},
		{"negative idle", ExtensionHostsConfig{Extensions: []string{"/e"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w", IdleReleaseMs: -1}}, "idleReleaseMs"},
		{"bad mode", ExtensionHostsConfig{Extensions: []string{"/e"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}, RunAs: &RunAsPrincipalConfig{Mode: "person"}}, "mode must be"},
		{"principal missing", ExtensionHostsConfig{Extensions: []string{"/e"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}, RunAs: &RunAsPrincipalConfig{Mode: RunAsModePrincipal}}, "principal is required"},
		{"principal no subject", ExtensionHostsConfig{Extensions: []string{"/e"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}, RunAs: &RunAsPrincipalConfig{Mode: RunAsModePrincipal, Principal: &SessionPrincipal{Provider: "os"}}}, "subject is required"},
		{"principal no provider", ExtensionHostsConfig{Extensions: []string{"/e"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}, RunAs: &RunAsPrincipalConfig{Mode: RunAsModePrincipal, Principal: &SessionPrincipal{Subject: "local:a"}}}, "provider is required"},
		{"workload with principal", ExtensionHostsConfig{Extensions: []string{"/e"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}, RunAs: &RunAsPrincipalConfig{Mode: RunAsModeWorkload, Principal: &SessionPrincipal{Subject: "x", Provider: "y"}}}, "not used in mode workload"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cfg.Validate()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestHeadlessSessionDefaults(t *testing.T) {
	cfg := &ExtensionHostsConfig{Extensions: []string{"/a", "/b"}, Session: HeadlessSessionConfig{WorkingDirectory: "/w"}}
	if got := cfg.SessionExtensions(); len(got) != 2 || got[0] != "/a" {
		t.Fatalf("session extensions default to the engine list: %v", got)
	}
	cfg.Session.Extensions = []string{"/c"}
	if got := cfg.SessionExtensions(); len(got) != 1 || got[0] != "/c" {
		t.Fatalf("explicit session extensions win: %v", got)
	}
	if cfg.Session.IdleRelease() != DefaultHeadlessIdleRelease {
		t.Fatal("zero idle release uses the default")
	}
	cfg.Session.IdleReleaseMs = 5000
	if cfg.Session.IdleRelease() != 5*time.Second {
		t.Fatal("idle release honours the configured value")
	}
	var nilCfg *ExtensionHostsConfig
	if nilCfg.SessionExtensions() != nil {
		t.Fatal("nil config has no extensions")
	}
}
