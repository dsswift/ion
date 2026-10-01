package utils

import (
	"os"
	"testing"
)

// A pod's hostname is its pod name, new on every restart. ION_HOST_NAME pins
// the host every log, telemetry, and egress record reports, so a restarted
// pod is the same host in a fleet view.
func TestHostName_OverrideNamesTheHostEverywhere(t *testing.T) {
	t.Setenv(HostNameEnv, "atlas-beta--example.apps.example.org")
	resetHostNameForTest()
	t.Cleanup(resetHostNameForTest)

	if got := HostName(); got != "atlas-beta--example.apps.example.org" {
		t.Fatalf("HostName() = %q, want the override", got)
	}
	if got := ResourceHostName(); got != "atlas-beta--example.apps.example.org" {
		t.Fatalf("ResourceHostName() = %q, want the override", got)
	}
	var host string
	for _, a := range egressResourceAttrs(egressRecord{Component: "server"}, nil) {
		if a.Key == "host.name" && a.Value.StringValue != nil {
			host = *a.Value.StringValue
		}
	}
	if host != "atlas-beta--example.apps.example.org" {
		t.Fatalf("egress host.name = %q, want the override", host)
	}
}

func TestHostName_FallsBackToTheOSHostname(t *testing.T) {
	t.Setenv(HostNameEnv, "  ")
	resetHostNameForTest()
	t.Cleanup(resetHostNameForTest)

	want, err := os.Hostname()
	if err != nil {
		t.Skip("no OS hostname on this machine")
	}
	if got := HostName(); got != want {
		t.Fatalf("HostName() = %q, want the OS hostname %q", got, want)
	}
}
