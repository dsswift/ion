package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// MDNSHandle wraps the dns-sd subprocess for clean shutdown.
type MDNSHandle struct {
	cmd *exec.Cmd
}

func (h *MDNSHandle) Shutdown() {
	if h.cmd != nil && h.cmd.Process != nil {
		h.cmd.Process.Kill() //nolint:errcheck // mDNS subprocess teardown
		h.cmd.Wait()         //nolint:errcheck // reaping the killed subprocess
	}
}

// StartMDNS advertises the relay on the local network as _ion-relay._tcp
// using the macOS dns-sd command, which registers through the system's
// mDNSResponder daemon. This is the only reliable way to make a service
// visible to Apple's NWBrowser on iOS.
//
// On non-macOS systems this is a no-op (returns nil handle, nil error).
func StartMDNS(ctx context.Context, port int) (*MDNSHandle, error) {
	// dns-sd is macOS-only. Skip silently on Linux (Docker, production).
	if _, err := exec.LookPath("dns-sd"); err != nil {
		logger.Info("mDNS skipped", "tag", "relay.mdns.skip", "reason", "dns-sd not found")
		return nil, nil
	}

	hostname, _ := os.Hostname() //nolint:errcheck // empty hostname falls back below
	hostname = strings.TrimSuffix(hostname, ".local")

	// dns-sd -R <name> <type> <domain> <port>
	// Registers a service with the system mDNS responder.
	cmd := exec.CommandContext(ctx, "dns-sd", "-R",
		hostname,
		"_ion-relay._tcp",
		"local",
		strconv.Itoa(port),
	)

	// Discard output; dns-sd prints registration status to stdout.
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	logger.Info("mDNS advertising", "tag", "relay.mdns.start", "hostname", hostname, "port", port, "pid", cmd.Process.Pid)
	return &MDNSHandle{cmd: cmd}, nil
}

// portFromString parses a port string, returning the default if invalid.
func portFromString(s string, defaultPort int) int {
	p, err := strconv.Atoi(s)
	if err != nil || p <= 0 {
		return defaultPort
	}
	return p
}
