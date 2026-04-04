package main

import (
	"context"
	"log"
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
		h.cmd.Process.Kill()
		h.cmd.Wait()
	}
}

// StartMDNS advertises the relay on the local network as _coda-relay._tcp
// using the macOS dns-sd command, which registers through the system's
// mDNSResponder daemon. This is the only reliable way to make a service
// visible to Apple's NWBrowser on iOS.
//
// On non-macOS systems this is a no-op (returns nil handle, nil error).
func StartMDNS(ctx context.Context, port int) (*MDNSHandle, error) {
	// dns-sd is macOS-only. Skip silently on Linux (Docker, production).
	if _, err := exec.LookPath("dns-sd"); err != nil {
		log.Println("mDNS: dns-sd not found, skipping (not macOS)")
		return nil, nil
	}

	hostname, _ := os.Hostname()
	hostname = strings.TrimSuffix(hostname, ".local")

	// dns-sd -R <name> <type> <domain> <port>
	// Registers a service with the system mDNS responder.
	cmd := exec.CommandContext(ctx, "dns-sd", "-R",
		hostname,
		"_coda-relay._tcp",
		"local",
		strconv.Itoa(port),
	)

	// Discard output; dns-sd prints registration status to stdout.
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	log.Printf("mDNS: advertising %s._coda-relay._tcp on port %d (pid %d)", hostname, port, cmd.Process.Pid)
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
