//go:build !windows

package main

import "syscall"

func init() {
	// Raise file descriptor soft limit to hard limit. The engine's workspace
	// watchers use kqueue (macOS) which consumes one FD per watched directory.
	// With multiple sessions watching large repo trees the default soft limit
	// (often 10240 on macOS) is easily exhausted, causing DNS lookups and
	// other socket operations to fail with "no such host" / EMFILE.
	var lim syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &lim); err == nil {
		if lim.Cur < lim.Max {
			lim.Cur = lim.Max
			_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &lim)
		}
	}
}
