package utils

import (
	"os"
	"strings"
	"sync"
)

// HostNameEnv names the host this process reports as, overriding the OS
// hostname. A container's hostname is its pod name, which changes on every
// restart; a deployment sets this to a name that outlives the pod (its public
// DNS name), so every restart reports as the same host.
const HostNameEnv = "ION_HOST_NAME"

var (
	hostNameOnce sync.Once
	hostName     string
)

// HostName is the name this process identifies its host by in logs,
// telemetry, and egress: ION_HOST_NAME when set, else the OS hostname. Read
// once per process. Network uses (addresses, discovery) read the OS hostname
// directly instead; this is identity only.
func HostName() string {
	hostNameOnce.Do(func() {
		if v := strings.TrimSpace(os.Getenv(HostNameEnv)); v != "" {
			hostName = v
			return
		}
		h, err := os.Hostname()
		if err != nil {
			return
		}
		hostName = h
	})
	return hostName
}

// resetHostNameForTest re-reads the environment on the next HostName call.
func resetHostNameForTest() {
	hostNameOnce = sync.Once{}
	hostName = ""
}
