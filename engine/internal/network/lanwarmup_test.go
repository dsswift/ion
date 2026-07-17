package network

import (
	"errors"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestParseRouteGateway(t *testing.T) {
	// Real `route -n get default` output shape on macOS.
	out := `   route to: default
destination: default
       mask: default
    gateway: 192.168.86.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`
	if got := parseRouteGateway(out); got != "192.168.86.1" {
		t.Fatalf("parseRouteGateway = %q, want 192.168.86.1", got)
	}
}

func TestParseRouteGatewayMissing(t *testing.T) {
	// No routed network: route prints an error or output without a gateway line.
	out := `route: writing to routing socket: not in table
`
	if got := parseRouteGateway(out); got != "" {
		t.Fatalf("parseRouteGateway = %q, want empty", got)
	}
}

func TestWarmLocalNetworkRetriesUntilReady(t *testing.T) {
	origSchedule, origGw, origProbe, origSupported := lanWarmupSchedule, gatewayFn, probeFn, lanWarmupSupported
	defer func() { lanWarmupSchedule, gatewayFn, probeFn, lanWarmupSupported = origSchedule, origGw, origProbe, origSupported }()
	lanWarmupSupported = true

	lanWarmupSchedule = []time.Duration{0, 0, 0, 0}

	// Attempt 1: gateway not up yet. Attempt 2: probe times out (consent
	// prompt pending). Attempt 3: ready. Attempt 4 must never run.
	gwCalls, probeCalls := 0, 0
	gatewayFn = func() (string, error) {
		gwCalls++
		if gwCalls == 1 {
			return "", errors.New("route: not in table")
		}
		return "192.168.1.1", nil
	}
	probeFn = func(gateway string, timeoutMs int) int {
		probeCalls++
		if probeCalls == 1 {
			return lanWarmTimeout
		}
		return lanWarmReady
	}

	WarmLocalNetwork(nil)

	if gwCalls != 3 {
		t.Fatalf("gateway lookups = %d, want 3 (retry past missing gateway, stop on ready)", gwCalls)
	}
	if probeCalls != 2 {
		t.Fatalf("probe calls = %d, want 2 (retry past timeout, stop on ready)", probeCalls)
	}
}

func TestWarmLocalNetworkGivesUpAfterSchedule(t *testing.T) {
	origSchedule, origGw, origProbe, origSupported := lanWarmupSchedule, gatewayFn, probeFn, lanWarmupSupported
	defer func() { lanWarmupSchedule, gatewayFn, probeFn, lanWarmupSupported = origSchedule, origGw, origProbe, origSupported }()
	lanWarmupSupported = true

	lanWarmupSchedule = []time.Duration{0, 0}
	probeCalls := 0
	gatewayFn = func() (string, error) { return "192.168.1.1", nil }
	probeFn = func(gateway string, timeoutMs int) int {
		probeCalls++
		return lanWarmFailed
	}

	WarmLocalNetwork(nil)

	if probeCalls != len(lanWarmupSchedule) {
		t.Fatalf("probe calls = %d, want %d (one per scheduled attempt, then stop)", probeCalls, len(lanWarmupSchedule))
	}
}

func TestWarmLocalNetworkDisabledByConfig(t *testing.T) {
	// The disabled path must return without probing. A real probe takes up to
	// lanWarmupTimeoutMs against the gateway; the config gate returns
	// immediately, so a generous wall-clock bound distinguishes the two.
	start := time.Now()
	WarmLocalNetwork(&types.NetworkConfig{DisableLanWarmup: true})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("disabled warmup took %v; config gate did not short-circuit", elapsed)
	}
}
