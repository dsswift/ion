package main

// cmd_studio_systemd.go — the Linux service manager for `ion studio`.
//
// User units under ~/.config/systemd/user, enabled with `--now`, plus
// `loginctl enable-linger` so they start at boot and outlive the SSH session
// that installed them. Lingering needs an administrator on some distros;
// when it cannot be enabled the install still succeeds and prints the one
// sudo command that fixes it.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

type systemdManager struct {
	r               cmdRunner
	l               studioLayout
	engineElsewhere bool
}

func newSystemdManager(r cmdRunner, l studioLayout) (*systemdManager, error) {
	m := &systemdManager{r: r, l: l}
	if _, code, err := r.Run("systemctl", "--user", "show-environment"); err != nil || code != 0 {
		return nil, errors.New("systemd user services are unavailable (systemctl --user failed); run `ion serve` and `node server/dist/main.js` under a supervisor of your own")
	}
	// A unit we did not write that is already active means another
	// installation owns the engine on this data dir.
	if out, code, _ := r.Run("systemctl", "--user", "show", studioEngineUnit+".service", "-p", "ActiveState", "-p", "ExecStart"); code == 0 { //nolint:errcheck // a failed show reads as "not installed"
		if strings.Contains(out, "ActiveState=active") && !strings.Contains(out, l.ionBin()) {
			m.engineElsewhere = true
		}
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "systemd manager selected", map[string]any{"engine_elsewhere": m.engineElsewhere})
	return m, nil
}

func (m *systemdManager) EngineOwnedElsewhere() bool { return m.engineElsewhere }

func (m *systemdManager) unitPath(u serviceUnit) string {
	return filepath.Join(m.l.home, ".config", "systemd", "user", u.Name+".service")
}

func (m *systemdManager) Install(u serviceUnit) error {
	if err := os.MkdirAll(filepath.Dir(m.unitPath(u)), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(m.unitPath(u), []byte(renderSystemdUnit(u)), 0o644); err != nil {
		return fmt.Errorf("write unit: %w", err)
	}
	if out, code, err := m.r.Run("systemctl", "--user", "daemon-reload"); err != nil || code != 0 {
		return fmt.Errorf("daemon-reload: %s", firstNonEmpty(out, errString(err)))
	}
	if out, code, err := m.r.Run("systemctl", "--user", "enable", "--now", u.Name+".service"); err != nil || code != 0 {
		return fmt.Errorf("enable %s: %s", u.Name, firstNonEmpty(out, errString(err)))
	}
	// Restart in case the unit was already running an older bundle.
	if out, code, err := m.r.Run("systemctl", "--user", "restart", u.Name+".service"); err != nil || code != 0 {
		return fmt.Errorf("restart %s: %s", u.Name, firstNonEmpty(out, errString(err)))
	}
	m.ensureLinger()
	utils.LogWithFields(utils.LevelInfo, studioTag, "systemd unit installed", map[string]any{"unit": u.Name, "path": m.unitPath(u)})
	return nil
}

// ensureLinger asks logind to keep the user manager alive across logouts.
// Failure is reported, not fatal: the services run now, they just stop at
// logout until an administrator runs the printed command.
func (m *systemdManager) ensureLinger() {
	out, code, err := m.r.Run("loginctl", "enable-linger", m.l.user)
	if err == nil && code == 0 {
		return
	}
	utils.LogWithFields(utils.LevelWarn, studioTag, "enable-linger failed", map[string]any{"output": out, "exit_code": code})
	fmt.Printf("==> could not enable lingering for %s; the services stop at logout until an administrator runs:\n    sudo loginctl enable-linger %s\n", m.l.user, m.l.user)
}

func (m *systemdManager) Restart(u serviceUnit) error {
	if out, code, err := m.r.Run("systemctl", "--user", "restart", u.Name+".service"); err != nil || code != 0 {
		return fmt.Errorf("restart %s: %s", u.Name, firstNonEmpty(out, errString(err)))
	}
	return nil
}

func (m *systemdManager) Uninstall(u serviceUnit) error {
	m.r.Run("systemctl", "--user", "disable", "--now", u.Name+".service") //nolint:errcheck // already-absent is fine
	if err := os.Remove(m.unitPath(u)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	m.r.Run("systemctl", "--user", "daemon-reload") //nolint:errcheck // best-effort after removal
	return nil
}

var systemdPIDRe = regexp.MustCompile(`(?m)^MainPID=(\d+)`)
var systemdActiveRe = regexp.MustCompile(`(?m)^ActiveState=(\S+)`)

func (m *systemdManager) Status(u serviceUnit) (serviceStatus, error) {
	st := serviceStatus{Label: u.Label}
	if _, err := os.Stat(m.unitPath(u)); errors.Is(err, os.ErrNotExist) {
		st.State = "not-installed"
		return st, nil
	}
	out, code, err := m.r.Run("systemctl", "--user", "show", u.Name+".service", "-p", "ActiveState", "-p", "MainPID")
	if err != nil {
		return st, err
	}
	if code != 0 {
		st.State = "unknown"
		st.Detail = strings.TrimSpace(out)
		return st, nil
	}
	return parseSystemdShow(u.Label, out), nil
}

func parseSystemdShow(label, out string) serviceStatus {
	st := serviceStatus{Label: label, State: "stopped"}
	if m := systemdActiveRe.FindStringSubmatch(out); m != nil {
		if m[1] == "active" {
			st.State = "running"
		} else {
			st.Detail = m[1]
		}
	}
	if m := systemdPIDRe.FindStringSubmatch(out); m != nil && m[1] != "0" {
		st.PID = m[1]
	}
	return st
}

func renderSystemdUnit(u serviceUnit) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[Unit]\nDescription=Ion %s\nAfter=network-online.target\n", u.Label)
	if u.Name == studioServerUnit {
		fmt.Fprintf(&b, "After=%s.service\nWants=%s.service\n", studioEngineUnit, studioEngineUnit)
	}
	b.WriteString("\n[Service]\nType=simple\n")
	fmt.Fprintf(&b, "ExecStart=%s\n", strings.Join(u.ProgramArgs, " "))
	fmt.Fprintf(&b, "WorkingDirectory=%s\n", u.WorkingDir)
	for _, k := range sortedEnvKeys(u.Env) {
		fmt.Fprintf(&b, "Environment=%s=%s\n", k, u.Env[k])
	}
	fmt.Fprintf(&b, "StandardOutput=append:%s\nStandardError=append:%s\n", u.StdoutPath, u.StderrPath)
	// on-failure mirrors launchd's SuccessfulExit=false: a graceful exit 0
	// stays down, a crash restarts after 5s.
	b.WriteString("Restart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n")
	return b.String()
}
