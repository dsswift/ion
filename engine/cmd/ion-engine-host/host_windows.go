//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"github.com/dsswift/ion/engine/internal/utils"
	"golang.org/x/sys/windows"
)

// createNoWindow is CREATE_NO_WINDOW: the child gets a console so its
// standard handles behave normally, but that console has no window. It is
// deliberately not DETACHED_PROCESS — a detached child leaves the job object
// this host puts it in, and the daemon would then survive `schtasks /End`.
const createNoWindow = 0x08000000

func usage() int {
	utils.Error("engine-host", "ion-engine-host takes the engine binary path followed by its arguments")
	return 2
}

// openLog opens one of the daemon's stream capture files, truncating it so a
// run's output is the run's own. A failure to open is not fatal: losing the
// capture file is worse than nothing, but losing the daemon over it is worse
// still, so the stream falls back to nil (discarded) and the reason is logged.
func openLog(ionHome, name string) *os.File {
	path := filepath.Join(ionHome, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "engine-host", "could not open stream capture file, output discarded", map[string]any{"path": path, "error": utils.ErrStr(err)})
		return nil
	}
	return f
}

// confineToJob puts pid in a new job object that kills its members when the
// job handle closes — which happens when this host exits, however it exits.
// That is what makes `schtasks /End` on the host stop the daemon, and what
// stops a killed host from orphaning one. Returns the job handle, which the
// caller must keep open for the lifetime of the child.
func confineToJob(pid int) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job) //nolint:errcheck // best-effort cleanup on the setup-failure path
		return 0, err
	}
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		windows.CloseHandle(job) //nolint:errcheck // best-effort cleanup on the setup-failure path
		return 0, err
	}
	defer windows.CloseHandle(proc) //nolint:errcheck // the job holds its own reference once assignment succeeds
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		windows.CloseHandle(job) //nolint:errcheck // best-effort cleanup on the setup-failure path
		return 0, err
	}
	return job, nil
}

func runHost(enginePath string, args []string) int {
	home, err := utils.UserHomeDir()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "engine-host", "could not resolve the user home directory", map[string]any{"error": utils.ErrStr(err)})
		return 1
	}
	ionHome := filepath.Join(home, ".ion")

	// The engine's own record of what it did is engine.jsonl. These two files
	// capture what it writes to the standard streams instead — a panic, a
	// linker error, a startup abort before logging is up — which on Windows
	// had nowhere to go at all. Same two filenames the macOS LaunchAgent
	// redirects to, so an operator looks in the same place on both platforms.
	stdout := openLog(ionHome, "engine-stdout.log")
	stderr := openLog(ionHome, "engine-stderr.log")
	defer func() {
		if stdout != nil {
			stdout.Close() //nolint:errcheck // best-effort close of a capture file at exit
		}
		if stderr != nil {
			stderr.Close() //nolint:errcheck // best-effort close of a capture file at exit
		}
	}()

	cmd := exec.Command(enginePath, args...)
	cmd.Dir = ionHome
	if stdout != nil {
		cmd.Stdout = stdout
	}
	if stderr != nil {
		cmd.Stderr = stderr
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}

	utils.LogWithFields(utils.LevelInfo, "engine-host", "starting the engine with no console window", map[string]any{"engine": enginePath, "args": args, "host_pid": os.Getpid()})
	if err := cmd.Start(); err != nil {
		utils.LogWithFields(utils.LevelError, "engine-host", "could not start the engine", map[string]any{"engine": enginePath, "error": utils.ErrStr(err)})
		return 1
	}

	pid := cmd.Process.Pid
	job, jobErr := confineToJob(pid)
	if jobErr != nil {
		// The daemon is already running and useful; refusing to supervise it
		// over a failed job assignment would be worse than supervising it
		// imperfectly. What is lost is the guarantee that killing the host
		// also kills the engine, so it is logged at WARN rather than passed over.
		utils.LogWithFields(utils.LevelWarn, "engine-host", "engine is not confined to a job object; killing the host will not stop it", map[string]any{"engine_pid": pid, "error": utils.ErrStr(jobErr)})
	} else {
		defer windows.CloseHandle(job) //nolint:errcheck // closing the job is what terminates the engine; the process is exiting either way
		utils.LogWithFields(utils.LevelInfo, "engine-host", "engine confined to a kill-on-close job object", map[string]any{"engine_pid": pid})
	}

	err = cmd.Wait()
	code := cmd.ProcessState.ExitCode()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "engine-host", "engine exited non-zero", map[string]any{"engine_pid": pid, "exit_code": code, "error": utils.ErrStr(err)})
	} else {
		utils.LogWithFields(utils.LevelInfo, "engine-host", "engine exited cleanly", map[string]any{"engine_pid": pid, "exit_code": code})
	}
	// Propagating the exit code is what lets the task's RestartOnFailure see
	// a failure at all: the task watches this host, not the engine.
	return code
}
