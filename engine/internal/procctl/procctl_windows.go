//go:build windows

package procctl

import (
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/dsswift/ion/engine/internal/utils"
)

// stillActive is the exit code Windows reports for a process that has not
// yet exited (STILL_ACTIVE / STATUS_PENDING). Not exported by x/sys/windows.
const stillActive = 259

// jobs tracks the Job Object handle assigned to each live *exec.Cmd, so
// KillTree and Release can find it later. Keyed by the command pointer
// because exec.Cmd carries no other stable identity before Start.
var jobs sync.Map // map[*exec.Cmd]windows.Handle

// Configure sets CREATE_NEW_PROCESS_GROUP so a Ctrl-C delivered to the
// engine's own console does not propagate to the child.
func Configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	utils.LogWithFields(utils.LevelDebug, tag, "configured process group", map[string]any{
		"platform": "windows",
	})
}

// AfterStart creates a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and
// assigns cmd's process to it, so KillTree can end the whole tree (and any
// grandchild such as a cmd.exe shim's node process) in one call, and the
// tree also dies if the engine process itself dies. Must be called
// immediately after cmd.Start succeeds. Returns an error only when the tree
// cannot be tracked; callers log and continue — KillTree degrades to
// killing the direct child only.
func AfterStart(cmd *exec.Cmd) error {
	pid := cmd.Process.Pid

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, tag, "job assignment failed, tree kill degraded to direct child", map[string]any{
			"pid":   pid,
			"error": err.Error(),
			"step":  "CreateJobObject",
		})
		return err
	}

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job) //nolint:errcheck // best-effort cleanup on the failure path
		utils.LogWithFields(utils.LevelWarn, tag, "job assignment failed, tree kill degraded to direct child", map[string]any{
			"pid":   pid,
			"error": err.Error(),
			"step":  "SetInformationJobObject",
		})
		return err
	}

	procHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		_ = windows.CloseHandle(job) //nolint:errcheck // best-effort cleanup on the failure path
		utils.LogWithFields(utils.LevelWarn, tag, "job assignment failed, tree kill degraded to direct child", map[string]any{
			"pid":   pid,
			"error": err.Error(),
			"step":  "OpenProcess",
		})
		return err
	}
	defer windows.CloseHandle(procHandle) //nolint:errcheck // best-effort handle cleanup

	if err := windows.AssignProcessToJobObject(job, procHandle); err != nil {
		_ = windows.CloseHandle(job) //nolint:errcheck // best-effort cleanup on the failure path
		utils.LogWithFields(utils.LevelWarn, tag, "job assignment failed, tree kill degraded to direct child", map[string]any{
			"pid":   pid,
			"error": err.Error(),
			"step":  "AssignProcessToJobObject",
		})
		return err
	}

	jobs.Store(cmd, job)
	utils.LogWithFields(utils.LevelInfo, tag, "process assigned to job object", map[string]any{
		"pid":      pid,
		"platform": "windows",
	})
	return nil
}

// Release drops the tracked Job Object handle for cmd, if any, closing it.
// Callers invoke this once after cmd.Wait returns.
func Release(cmd *exec.Cmd) {
	if v, ok := jobs.LoadAndDelete(cmd); ok {
		job, _ := v.(windows.Handle)
		_ = windows.CloseHandle(job) //nolint:errcheck // best-effort handle cleanup
	}
}

// Interrupt always returns ErrNoGracefulSignal: there is no cross-console way
// to deliver Ctrl-C to a process outside the caller's own console group on
// Windows. Callers fall back to KillTree.
func Interrupt(cmd *exec.Cmd) error {
	return ErrNoGracefulSignal
}

// KillTree ends the whole tree via TerminateJobObject when a job was
// attached by AfterStart, falling back to killing the direct child when no
// job is tracked (AfterStart failed, was never called, or already ran).
func KillTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	if v, ok := jobs.LoadAndDelete(cmd); ok {
		job, _ := v.(windows.Handle)
		err := windows.TerminateJobObject(job, 1)
		_ = windows.CloseHandle(job) //nolint:errcheck // best-effort handle cleanup
		utils.LogWithFields(utils.LevelInfo, tag, "terminated job object", map[string]any{
			"pid":      pid,
			"platform": "windows",
			"error":    errString(err),
		})
		return err
	}
	utils.LogWithFields(utils.LevelInfo, tag, "no job attached, killing direct child", map[string]any{
		"pid":      pid,
		"platform": "windows",
	})
	return cmd.Process.Kill()
}

// Alive reports whether a process with pid exists and has not exited. A
// zombie handle held open by a just-killed process still opens successfully,
// so the exit code must be checked rather than the OpenProcess result alone.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h) //nolint:errcheck // best-effort handle cleanup
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
