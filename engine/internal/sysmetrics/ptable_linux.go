//go:build linux

package sysmetrics

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// parentTable returns pid → parent pid for every process, from one pass over
// /proc/<pid>/stat. Only the engine's own descendants are kept from it (see
// walkTree).
func parentTable() (map[int32]int32, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	out := make(map[int32]int32, len(entries))
	for _, e := range entries {
		pid, err := strconv.ParseInt(e.Name(), 10, 32)
		if err != nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue // the process exited between the listing and the read
		}
		if ppid, ok := parseStatPpid(string(b)); ok {
			out[int32(pid)] = ppid
		}
	}
	return out, nil
}

// parseStatPpid reads the parent pid from a /proc/<pid>/stat line. The
// command name (field 2) is parenthesised and may itself contain spaces or
// parentheses, so parsing starts after the LAST ')'.
func parseStatPpid(stat string) (int32, bool) {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return 0, false
	}
	fields := strings.Fields(stat[i+1:])
	if len(fields) < 2 {
		return 0, false
	}
	ppid, err := strconv.ParseInt(fields[1], 10, 32)
	if err != nil {
		return 0, false
	}
	return int32(ppid), true
}
