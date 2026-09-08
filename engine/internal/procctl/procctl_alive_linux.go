//go:build linux

package procctl

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Alive reports whether a Linux process exists and is not an exited zombie.
// kill(pid, 0) still succeeds for a zombie until its parent reaps it, so read
// /proc state to keep liveness callers from treating a dead tree member as live.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	state, err := linuxProcessState(pid)
	if err != nil {
		return false
	}
	return state != 'Z' && state != 'X'
}

func linuxProcessState(pid int) (byte, error) {
	file, err := os.Open(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	defer file.Close() //nolint:errcheck // read-only procfs descriptor

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "State:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, fmt.Errorf("invalid process state for pid %s", strconv.Itoa(pid))
		}
		return fields[1][0], nil
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("process state missing for pid %s", strconv.Itoa(pid))
}
