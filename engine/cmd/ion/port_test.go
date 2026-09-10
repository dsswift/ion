package main

import (
	"runtime"
	"testing"
)

// Shared vectors: the same SID/port pairs are asserted in the desktop's
// engine-address test. If either side changes its derivation, one of the two
// suites fails rather than both silently agreeing on nothing.
var portVectors = map[string]int{
	"S-1-5-21-1696802954-1770460993-270566097-1000": 52700,
	"S-1-5-21-1696802954-1770460993-270566097-1001": 51784,
	"S-1-5-18": 51925,
}

func TestUserScopedPortVectors(t *testing.T) {
	for sid, want := range portVectors {
		if got := derivePort(sid); got != want {
			t.Errorf("derivePort(%q) = %d, want %d", sid, got, want)
		}
	}
}

// The whole point: two accounts on one machine must not resolve to the same
// address. Same-SID stability matters just as much -- the port has to survive
// a restart with no stored state.
func TestUserScopedPortIsPerUserAndStable(t *testing.T) {
	a := derivePort("S-1-5-21-1696802954-1770460993-270566097-1000")
	b := derivePort("S-1-5-21-1696802954-1770460993-270566097-1001")
	if a == b {
		t.Errorf("two SIDs derived the same port %d; users on a multi-session host would collide", a)
	}
	if a != derivePort("S-1-5-21-1696802954-1770460993-270566097-1000") {
		t.Error("derivation is not stable for the same SID")
	}
}

// The range must stay inside IANA's dynamic/private range, where no
// registered service may claim the port.
func TestUserScopedPortRange(t *testing.T) {
	for _, sid := range []string{"S-1-5-18", "S-1-5-21-1-2-3-1000", "S-1-5-21-9-9-9-1234"} {
		p := derivePort(sid)
		if p < 49152 || p > 65535 {
			t.Errorf("derivePort(%q) = %d, outside the dynamic port range", sid, p)
		}
	}
}

// There is no shared fallback port any more.
//
// The old code returned 21017 whenever the SID could not be read. Two users
// whose lookups both failed on the same host resolved to the SAME address, and
// the second desktop attached to the first user's engine. This asserts the
// constant is gone from the derivation entirely: 21017 sits outside the
// derived range, so no input can produce it.
func TestNoSharedFallbackPortIsReachableByDerivation(t *testing.T) {
	const removedSharedPort = 21017
	for _, sid := range []string{
		"S-1-5-18",
		"S-1-5-21-1696802954-1770460993-270566097-1000",
		"S-1-5-21-1696802954-1770460993-270566097-1001",
		"",
	} {
		if got := derivePort(sid); got == removedSharedPort {
			t.Fatalf("derivePort(%q) produced the removed shared port %d", sid, removedSharedPort)
		}
	}
}

// Off Windows, asking for a per-user port is a programming error, not a
// value: the platform uses a per-user socket path instead. It must return an
// error rather than a port nobody is listening on.
func TestUserScopedPortIsAnErrorOffWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has a real implementation; see port_windows.go")
	}
	if _, err := userScopedPort(); err == nil {
		t.Fatal("userScopedPort returned a port on a platform that uses a socket path")
	}
}

// The explicit override still wins on every platform, which is what a
// deployment with its own port plan and every test harness relies on.
func TestResolveSocketPathHonoursTheExplicitOverride(t *testing.T) {
	t.Setenv("ION_SOCKET_PATH", "10.0.0.5:9999")
	got, err := resolveSocketPath()
	if err != nil {
		t.Fatalf("resolveSocketPath: %v", err)
	}
	if got != "10.0.0.5:9999" {
		t.Errorf("resolveSocketPath() = %q, want the ION_SOCKET_PATH value", got)
	}
	if net := dialNetwork(got); net != "tcp4" {
		t.Errorf("dialNetwork(%q) = %q, want tcp4", got, net)
	}
}

// dialNetwork describes the address it is handed rather than re-resolving.
// Re-resolving on Windows would be a second SID lookup that could disagree
// with the first, and the network must always match the address dialled.
func TestDialNetworkDescribesTheAddressItIsGiven(t *testing.T) {
	if got := dialNetwork("/home/u/.ion/engine.sock"); got != "unix" {
		t.Errorf("dialNetwork(socket path) = %q, want unix", got)
	}
	if got := dialNetwork("127.0.0.1:52700"); got != "tcp4" {
		t.Errorf("dialNetwork(host:port) = %q, want tcp4", got)
	}
}
