package main

// cmd_studio_service.go — the service-manager seam behind `ion studio`.
//
// One interface, two implementations (launchd, systemd), one fake for
// tests. Every OS call goes through cmdRunner so the tests drive the branch
// logic (gui vs system domain, sudo needed or not, already-installed
// engine) without a real launchctl.

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// serviceUnit is one background service, described independently of the
// manager that will run it.
type serviceUnit struct {
	// Label is the launchd label; Name is the systemd unit stem.
	Label string
	Name  string
	// ProgramArgs is argv[0..].
	ProgramArgs []string
	Env         map[string]string
	WorkingDir  string
	StdoutPath  string
	StderrPath  string
}

// serviceStatus is what `ion studio status` reports per unit.
type serviceStatus struct {
	Label  string `json:"label"`
	State  string `json:"state"` // running | stopped | not-installed | unknown
	PID    string `json:"pid,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// serviceManager installs and drives units. EngineOwnedElsewhere reports
// that an engine service is already loaded on the host outside our control
// (a laptop running the desktop's own engine), in which case only the server
// unit is managed here.
type serviceManager interface {
	Install(u serviceUnit) error
	Restart(u serviceUnit) error
	Uninstall(u serviceUnit) error
	Status(u serviceUnit) (serviceStatus, error)
	EngineOwnedElsewhere() bool
}

// cmdRunner is the exec seam. Run returns combined stdout/stderr and the
// exit code; err is non-nil only when the process could not be started.
type cmdRunner interface {
	Run(name string, args ...string) (out string, exitCode int, err error)
}

type execRunner struct{}

func (execRunner) Run(name string, args ...string) (string, int, error) {
	cmd := exec.Command(name, args...)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	code := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
		err = nil
	}
	utils.LogWithFields(utils.LevelDebug, studioTag, "ran command", map[string]any{
		"cmd": name + " " + strings.Join(args, " "), "exit_code": code, "output_bytes": buf.Len(),
	})
	if err != nil {
		return buf.String(), -1, err
	}
	return buf.String(), code, nil
}

// newServiceManager picks the manager for this OS. forceSystem selects the
// macOS system domain (LaunchDaemons) regardless of whether a gui session
// exists.
func newServiceManager(r cmdRunner, l studioLayout, forceSystem bool) (serviceManager, error) {
	switch runtime.GOOS {
	case "darwin":
		return newLaunchdManager(r, l, forceSystem)
	case "linux":
		return newSystemdManager(r, l)
	default:
		return nil, fmt.Errorf("ion studio manages services on macOS (launchd) and Linux (systemd) only; %s is not supported", runtime.GOOS)
	}
}

// studioUnits is the engine unit followed by the server unit. Order matters:
// install starts the engine first, uninstall stops the server first.
func studioUnits(l studioLayout) []serviceUnit {
	path := "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	return []serviceUnit{
		{
			Label:       studioEngineLabel,
			Name:        studioEngineUnit,
			ProgramArgs: []string{l.ionBin(), "serve"},
			Env:         map[string]string{"HOME": l.home, "ION_DATA_DIR": l.dataDir, "PATH": path},
			WorkingDir:  l.home,
			StdoutPath:  filepath.Join(l.dataDir, "engine-stdout.log"),
			StderrPath:  filepath.Join(l.dataDir, "engine-stderr.log"),
		},
		{
			Label:       studioServerLabel,
			Name:        studioServerUnit,
			ProgramArgs: []string{l.nodeBin(), l.serverMain()},
			Env: map[string]string{
				"HOME": l.home, "ION_DATA_DIR": l.dataDir, "NODE_ENV": "production",
				"PATH": filepath.Dir(l.nodeBin()) + ":" + path,
			},
			WorkingDir: l.serverDir(),
			StdoutPath: filepath.Join(l.dataDir, "studio-server-stdout.log"),
			StderrPath: filepath.Join(l.dataDir, "studio-server-stderr.log"),
		},
	}
}

// sortedEnvKeys keeps rendered units byte-stable so a re-render never
// churns the file.
func sortedEnvKeys(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	return keys
}
