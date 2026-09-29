// Package sysmetrics samples System Metrics: how busy the host is, and what
// each process in the engine's own process tree is using.
//
// It walks only the engine's own tree, never the whole host, and it never
// records a command line. Each process is labeled with a role from a small
// fixed set (types.SystemMetricsRole*), learned from the spawn site that
// started it.
package sysmetrics

import (
	"sync"

	"github.com/shirou/gopsutil/v4/process"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// registration is what a spawn site told us about a child it started.
type registration struct {
	role string
	name string
	// startMs is the process start time read at registration (0 when it
	// could not be read). A pid seen later with a different start time is
	// a different process that reused the pid, and the registration does
	// not apply to it.
	startMs int64
}

var (
	registryMu sync.Mutex
	registry   = map[int32]registration{}
)

// RegisterProcess records the role and short name of a child process the
// engine just started. Spawn sites call it right after cmd.Start. The name is
// an extension name, an MCP server name, or a tag: never a command line.
//
// The process start time is read here and stored with the registration, so a
// later process that reuses the pid is not given this role (see
// lookupRegistration). The spawn site's UnregisterProcess, or the pid leaving
// the engine's tree, clears the entry.
func RegisterProcess(pid int, role, name string) {
	if pid <= 0 {
		return
	}
	start := processStartMs(int32(pid))
	registryMu.Lock()
	registry[int32(pid)] = registration{role: role, name: name, startMs: start}
	registryMu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "sysmetrics", "process registered", map[string]any{
		"pid": pid, "role": role, "name": name,
	})
}

// UnregisterProcess forgets a child that has exited.
func UnregisterProcess(pid int) {
	if pid <= 0 {
		return
	}
	registryMu.Lock()
	_, ok := registry[int32(pid)]
	delete(registry, int32(pid))
	registryMu.Unlock()
	if ok {
		utils.LogWithFields(utils.LevelDebug, "sysmetrics", "process unregistered", map[string]any{"pid": pid})
	}
}

// lookupRegistration returns what a spawn site registered for the process
// (pid, startMs). A registration whose recorded start time differs is for an
// earlier process that held the same pid, so it is ignored.
func lookupRegistration(pid int32, startMs int64) (registration, bool) {
	registryMu.Lock()
	defer registryMu.Unlock()
	r, ok := registry[pid]
	if !ok {
		return registration{}, false
	}
	if r.startMs != 0 && startMs != 0 && r.startMs != startMs {
		return registration{}, false
	}
	return r, true
}

// pruneRegistry drops registrations whose pid is no longer in the tree, so a
// spawn site that never unregistered cannot leak entries or later mislabel a
// process that reuses the pid.
func pruneRegistry(live map[int32]bool) {
	registryMu.Lock()
	defer registryMu.Unlock()
	for pid := range registry {
		if !live[pid] {
			delete(registry, pid)
		}
	}
}

// isKnownRole reports whether role is one of the fixed role values.
func isKnownRole(role string) bool {
	switch role {
	case types.SystemMetricsRoleEngine, types.SystemMetricsRoleExtension,
		types.SystemMetricsRoleMcp, types.SystemMetricsRoleBackend, types.SystemMetricsRoleTool:
		return true
	}
	return false
}

// processStartMs returns a process's start time in Unix ms, or 0 when it
// cannot be read.
func processStartMs(pid int32) int64 {
	p, err := process.NewProcess(pid)
	if err != nil {
		return 0
	}
	ms, err := p.CreateTime()
	if err != nil {
		return 0
	}
	return ms
}
