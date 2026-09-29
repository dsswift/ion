package main

import (
	"os"
	"strings"
	"sync"
)

// relayHostName is the device name the relay stamps on every log line as
// fields.host and on every shipped record, so collection can slice the
// relay by device like every other surface. RELAY_HOST overrides it; in a
// Deployment the OS hostname is the pod name, which changes on every
// rollout. Resolved once.
var relayHostName = sync.OnceValue(func() string {
	if v := strings.TrimSpace(os.Getenv("RELAY_HOST")); v != "" {
		return v
	}
	host, err := os.Hostname()
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(host, ".local")
})
