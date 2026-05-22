package extension

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

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
		utils.Log("procregistry", fmt.Sprintf("NewProcessRegistry: mkdir %s failed: %v", dir, err))
		return nil, fmt.Errorf("procregistry: mkdir %s: %w", dir, err)
	}
	utils.Log("procregistry", fmt.Sprintf("NewProcessRegistry: ready dir=%s", dir))
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
		utils.Log("procregistry", fmt.Sprintf("Deregister %s: remove %s failed: %v", name, path, err))
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
	return isProcessAlive(info.PID)
}

// Terminate sends SIGTERM to a registered process, then SIGKILL after 5s.
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
	if !isProcessAlive(info.PID) {
		r.Deregister(name)
		return nil
	}
	proc, err := os.FindProcess(info.PID)
	if err != nil {
		r.Deregister(name)
		return err
	}
	// SIGTERM
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		utils.Log("procregistry", fmt.Sprintf("Terminate %s: SIGTERM to pid %d failed: %v", name, info.PID, err))
	}
	// Wait up to 5s, then SIGKILL
	go func() {
		time.Sleep(5 * time.Second)
		if isProcessAlive(info.PID) {
			if err := proc.Signal(syscall.SIGKILL); err != nil {
				utils.Log("procregistry", fmt.Sprintf("Terminate %s: SIGKILL to pid %d failed: %v", name, info.PID, err))
			}
			utils.Log("procregistry", fmt.Sprintf("killed %s (pid %d) after SIGTERM timeout", name, info.PID))
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
		if !isProcessAlive(info.PID) {
			pidPath := filepath.Join(r.dir, entry.Name())
			if err := os.Remove(pidPath); err != nil && !os.IsNotExist(err) {
				utils.Log("procregistry", fmt.Sprintf("CleanStale: remove %s failed: %v", pidPath, err))
				continue
			}
			cleaned++
		}
	}
	return cleaned
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// Signal 0 checks if process exists without killing it
	return proc.Signal(syscall.Signal(0)) == nil
}
