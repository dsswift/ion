package extension

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/procctl"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ProcessInfo describes a registered process.
type ProcessInfo struct {
	Name      string `json:"name"`
	PID       int    `json:"pid"`
	Task      string `json:"task"`
	StartedAt string `json:"startedAt"`
}

// ProcessRegistry manages PID files for extension-spawned subprocesses.
type ProcessRegistry struct {
	dir string // directory for PID files (e.g., ~/.ion/agent-pids/)
}

// NewProcessRegistry creates a registry backed by the given directory.
// Returns an error if the directory cannot be created — callers must
// surface this rather than letting every later Register call silently
// fail.
func NewProcessRegistry(dir string) (*ProcessRegistry, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		utils.LogWithFields(utils.LevelInfo, "procregistry", "newprocessregistry: mkdir failed", map[string]any{"dir": dir, "error": err})
		return nil, fmt.Errorf("procregistry: mkdir %s: %w", dir, err)
	}
	utils.LogWithFields(utils.LevelInfo, "procregistry", "newprocessregistry: ready", map[string]any{"dir": dir})
	return &ProcessRegistry{dir: dir}, nil
}

// Register records a process.
func (r *ProcessRegistry) Register(name string, pid int, task string) error {
	info := ProcessInfo{
		Name:      name,
		PID:       pid,
		Task:      task,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(info)
	if err != nil {
		return err
	}
	path := filepath.Join(r.dir, name+".pid")
	return os.WriteFile(path, data, 0o644)
}

// Deregister removes a process registration.
func (r *ProcessRegistry) Deregister(name string) {
	path := filepath.Join(r.dir, name+".pid")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		utils.LogWithFields(utils.LevelInfo, "procregistry", "deregister : remove failed", map[string]any{"model": name, "path": path, "error": err})
	}
}

// List returns all registered processes.
func (r *ProcessRegistry) List() []ProcessInfo {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return nil
	}
	var result []ProcessInfo
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".pid" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(r.dir, entry.Name()))
		if err != nil {
			continue
		}
		var info ProcessInfo
		if json.Unmarshal(data, &info) == nil {
			result = append(result, info)
		}
	}
	return result
}

// IsAlive checks if a registered process is still running.
func (r *ProcessRegistry) IsAlive(name string) bool {
	path := filepath.Join(r.dir, name+".pid")
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var info ProcessInfo
	if json.Unmarshal(data, &info) != nil {
		return false
	}
	return procctl.Alive(info.PID)
}

// Terminate stops a registered process. On unix it sends SIGTERM, waits up
// to 5s, then SIGKILL. Windows has no SIGTERM equivalent that a process can
// catch, so it waits the same 5s grace period and then force-kills via
// procctl.KillTree — giving any Windows consumer's own cleanup logic (if it
// polls for shutdown) the same window unix processes get.
func (r *ProcessRegistry) Terminate(name string) error {
	path := filepath.Join(r.dir, name+".pid")
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("process %q not registered", name)
	}
	var info ProcessInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return err
	}
	if !procctl.Alive(info.PID) {
		r.Deregister(name)
		return nil
	}
	proc, err := os.FindProcess(info.PID)
	if err != nil {
		r.Deregister(name)
		return err
	}
	if runtime.GOOS == "windows" {
		utils.LogWithFields(utils.LevelInfo, "procregistry", "terminate: no sigterm on windows, killing after grace", map[string]any{"name": name, "pid": info.PID})
		go func() {
			time.Sleep(5 * time.Second)
			if procctl.Alive(info.PID) {
				if err := proc.Kill(); err != nil {
					utils.LogWithFields(utils.LevelInfo, "procregistry", "terminate: kill after grace failed", map[string]any{"model": name, "run_id": info.PID, "error": err})
				}
				utils.LogWithFields(utils.LevelInfo, "procregistry", "killed pid after grace", map[string]any{"model": name, "run_id": info.PID})
			}
			r.Deregister(name)
		}()
		return nil
	}
	// SIGTERM
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		utils.LogWithFields(utils.LevelInfo, "procregistry", "terminate : sigterm to pid failed", map[string]any{"model": name, "run_id": info.PID, "error": err})
	}
	// Wait up to 5s, then SIGKILL
	go func() {
		time.Sleep(5 * time.Second)
		if procctl.Alive(info.PID) {
			if err := proc.Signal(syscall.SIGKILL); err != nil {
				utils.LogWithFields(utils.LevelInfo, "procregistry", "terminate : sigkill to pid failed", map[string]any{"model": name, "run_id": info.PID, "error": err})
			}
			utils.LogWithFields(utils.LevelInfo, "procregistry", "killed (pid ) after sigterm timeout", map[string]any{"model": name, "run_id": info.PID})
		}
		r.Deregister(name)
	}()
	return nil
}

// CleanStale removes PID files for processes that are no longer alive.
func (r *ProcessRegistry) CleanStale() int {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return 0
	}
	cleaned := 0
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".pid" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(r.dir, entry.Name()))
		if err != nil {
			continue
		}
		var info ProcessInfo
		if json.Unmarshal(data, &info) != nil {
			continue
		}
		if !procctl.Alive(info.PID) {
			pidPath := filepath.Join(r.dir, entry.Name())
			if err := os.Remove(pidPath); err != nil && !os.IsNotExist(err) {
				utils.LogWithFields(utils.LevelInfo, "procregistry", "cleanstale: remove failed", map[string]any{"run_id": pidPath, "error": err})
				continue
			}
			cleaned++
		}
	}
	return cleaned
}
