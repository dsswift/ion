package fleet

import (
	"strings"
	"testing"
)

// A host that reboots or drops off the network during a long step must not
// leave ssh waiting on a dead connection forever.
func TestSSHArgs_GiveUpOnASilentHost(t *testing.T) {
	all := strings.Join(sshArgs, " ")
	for _, want := range []string{"BatchMode=yes", "ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=3"} {
		if !strings.Contains(all, want) {
			t.Errorf("sshArgs lack %s: %s", want, all)
		}
	}
}
