package main

// cmd_studio_launchd.go — the macOS service manager for `ion studio`.
//
// Two domains, chosen once at construction:
//
//   - gui/<uid> (LaunchAgents in ~/Library/LaunchAgents): the normal case on
//     a Mac somebody is logged into. No privileges needed.
//   - system (LaunchDaemons in /Library/LaunchDaemons, running as the
//     installing user): a headless Mac reached over SSH has no gui session,
//     so a LaunchAgent would never load. Needs sudo, which must be
//     passwordless when there is no tty to prompt on.
//
// A plist is regenerated on every install so a version bump that changes a
// path (it should not: the services run from `current`) still lands.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

type launchdManager struct {
	r               cmdRunner
	l               studioLayout
	system          bool
	uid             int
	engineElsewhere bool
	// sleep is the wait between unload polls; tests replace it.
	sleep func(time.Duration)
}

func newLaunchdManager(r cmdRunner, l studioLayout, forceSystem bool) (*launchdManager, error) {
	m := &launchdManager{r: r, l: l, uid: os.Getuid(), sleep: time.Sleep}
	guiLoadable := m.guiDomainLoadable()
	switch {
	case forceSystem:
		m.system = true
	case guiLoadable:
		m.system = false
	default:
		m.system = true
	}
	if m.system {
		if err := m.ensureSudo(); err != nil {
			return nil, err
		}
	}
	// An engine loaded in the gui domain that is not ours (the desktop's
	// LaunchAgent at ~/.ion/bin/ion) means this laptop already runs an
	// engine on the same data dir. Do not install a second one.
	if !m.system && guiLoadable {
		out, code, _ := r.Run("launchctl", "print", fmt.Sprintf("gui/%d/%s", m.uid, studioEngineLabel)) //nolint:errcheck // a launch failure reads as "not loaded"
		if code == 0 && !strings.Contains(out, m.l.ionBin()) {
			m.engineElsewhere = true
		}
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "launchd manager selected", map[string]any{
		"domain": m.domain(), "gui_loadable": guiLoadable, "force_system": forceSystem, "engine_elsewhere": m.engineElsewhere,
	})
	return m, nil
}

func (m *launchdManager) EngineOwnedElsewhere() bool { return m.engineElsewhere }

func (m *launchdManager) domain() string {
	if m.system {
		return "system"
	}
	return fmt.Sprintf("gui/%d", m.uid)
}

func (m *launchdManager) guiDomainLoadable() bool {
	_, code, err := m.r.Run("launchctl", "print", fmt.Sprintf("gui/%d", m.uid))
	return err == nil && code == 0
}

// ensureSudo proves the system domain is reachable before any file is
// written. `sudo -n true` succeeds only with cached or passwordless sudo; a
// tty can still prompt, no tty cannot.
func (m *launchdManager) ensureSudo() error {
	_, code, err := m.r.Run("sudo", "-n", "true")
	if err == nil && code == 0 {
		return nil
	}
	if stdinIsTerminal() {
		fmt.Println("==> installing system LaunchDaemons needs administrator rights (sudo)")
		return nil
	}
	return errors.New("this host has no GUI session, so the services must be system LaunchDaemons, and sudo needs a password but there is no terminal to ask on. " +
		"Either enable passwordless sudo for this user, or run interactively: ssh -t <host> '~/.ion/studio-server/current/bin/ion studio install --system'")
}

// privileged runs a launchctl/install command with sudo in the system
// domain and directly otherwise.
func (m *launchdManager) privileged(name string, args ...string) (string, int, error) {
	if m.system {
		return m.r.Run("sudo", append([]string{name}, args...)...)
	}
	return m.r.Run(name, args...)
}

// label is the launchd label a unit runs under. The gui domain is already
// one account's, so the bare label is unambiguous there. The system domain
// is the whole host's, and a host is shared between accounts while an
// install is one account's, so the label carries the account name: two
// people's installs on one headless Mac are `com.ion.studio-server.alice`
// and `com.ion.studio-server.bob`, never one plist overwriting the other.
func (m *launchdManager) label(u serviceUnit) string {
	if m.system {
		return u.Label + "." + m.l.user
	}
	return u.Label
}

func (m *launchdManager) plistPath(u serviceUnit) string {
	if m.system {
		return filepath.Join("/Library/LaunchDaemons", m.label(u)+".plist")
	}
	return filepath.Join(m.l.home, "Library", "LaunchAgents", u.Label+".plist")
}

func (m *launchdManager) target(u serviceUnit) string { return m.domain() + "/" + m.label(u) }

// legacyDaemonsDir is where an install made before labels carried the
// account name put its system-domain plist; a variable so tests can point
// it at a scratch directory.
var legacyDaemonsDir = "/Library/LaunchDaemons"

func (m *launchdManager) legacyPlistPath(u serviceUnit) string {
	return filepath.Join(legacyDaemonsDir, u.Label+".plist")
}

// retireLegacyLabel boots out and removes the unqualified system-domain
// plist for `u` when it is THIS install's (its ION_DATA_DIR is ours), so a
// reinstall migrates to the account-qualified label instead of running two
// copies of the same server. Another account's plist under the bare label
// is left alone: it is not ours to touch, and Install's port choice already
// keeps the two apart.
func (m *launchdManager) retireLegacyLabel(u serviceUnit) error {
	if !m.system {
		return nil
	}
	data, err := os.ReadFile(m.legacyPlistPath(u))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", m.legacyPlistPath(u), err)
	}
	if !strings.Contains(string(data), "<key>ION_DATA_DIR</key><string>"+xmlEscape(m.l.dataDir)+"</string>") {
		utils.LogWithFields(utils.LevelInfo, studioTag, "legacy launchd label belongs to another data dir; left alone", map[string]any{"label": u.Label, "plist": m.legacyPlistPath(u)})
		return nil
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "retiring legacy launchd label for this data dir", map[string]any{"label": u.Label, "replacement": m.label(u)})
	legacy := m.domain() + "/" + u.Label
	if _, code, _ := m.privileged("launchctl", "bootout", legacy); code == 0 { //nolint:errcheck // not loaded is fine
		if err := m.waitUnloadedTarget(legacy, unloadWait); err != nil {
			return err
		}
	}
	if out, code, err := m.r.Run("sudo", "rm", "-f", m.legacyPlistPath(u)); err != nil || code != 0 {
		return fmt.Errorf("remove %s: %s", m.legacyPlistPath(u), firstNonEmpty(out, errString(err)))
	}
	return nil
}

// launchdExitTimeout is the plist's ExitTimeOut: how long launchd lets a
// service finish a graceful shutdown before killing it.
const launchdExitTimeout = 30 * time.Second

// unloadWait is how long Install waits for launchd to finish tearing a
// booted-out service down: the plist's ExitTimeOut plus headroom for
// launchd's own bookkeeping.
const unloadWait = launchdExitTimeout + 15*time.Second

func (m *launchdManager) Install(u serviceUnit) error {
	plist := renderLaunchdPlist(u, m.system, m.l.user)
	// Bootout first so a re-install restarts with the new plist; a missing
	// service is not an error here. Bootout returns before launchd has
	// finished tearing the service down, and a bootstrap that lands in that
	// window fails with "Bootstrap failed: 5: Input/output error" (seen on
	// the first headless reinstall), so wait until the label is gone.
	// The plist grants the server ExitTimeOut (30s) to finish a graceful
	// shutdown, so the wait must outlast that: a shorter one aborted a
	// reinstall while the old server was still draining, and left the host
	// with the service unloaded and nothing to replace it.
	if err := m.retireLegacyLabel(u); err != nil {
		return err
	}
	if _, code, _ := m.privileged("launchctl", "bootout", m.target(u)); code == 0 { //nolint:errcheck // absent service is the common case on first install
		if err := m.waitUnloaded(u, unloadWait); err != nil {
			return err
		}
	}
	if m.system {
		tmp := filepath.Join(os.TempDir(), m.label(u)+".plist")
		if err := os.WriteFile(tmp, []byte(plist), 0o644); err != nil {
			return fmt.Errorf("stage plist: %w", err)
		}
		defer os.Remove(tmp) //nolint:errcheck // best-effort temp cleanup
		if out, code, err := m.r.Run("sudo", "install", "-o", "root", "-g", "wheel", "-m", "644", tmp, m.plistPath(u)); err != nil || code != 0 {
			return fmt.Errorf("install plist to %s: %s", m.plistPath(u), firstNonEmpty(out, errString(err)))
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(m.plistPath(u)), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(m.plistPath(u), []byte(plist), 0o644); err != nil {
			return fmt.Errorf("write plist: %w", err)
		}
	}
	if out, code, err := m.privileged("launchctl", "bootstrap", m.domain(), m.plistPath(u)); err != nil || code != 0 {
		return fmt.Errorf("launchctl bootstrap %s: %s", m.target(u), firstNonEmpty(out, errString(err)))
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "launchd unit installed", map[string]any{"label": m.label(u), "plist": m.plistPath(u), "domain": m.domain()})
	return nil
}

// waitUnloaded polls `launchctl print` until the label is no longer known to
// the domain, or the deadline passes.
func (m *launchdManager) waitUnloaded(u serviceUnit, timeout time.Duration) error {
	return m.waitUnloadedTarget(m.target(u), timeout)
}

func (m *launchdManager) waitUnloadedTarget(target string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, code, err := m.privileged("launchctl", "print", target)
		if err != nil {
			return fmt.Errorf("launchctl print %s: %w", target, err)
		}
		if code != 0 {
			utils.LogWithFields(utils.LevelDebug, studioTag, "launchd service unloaded", map[string]any{"target": target})
			return nil
		}
		m.sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("%s is still loaded %s after bootout", target, timeout)
}

func (m *launchdManager) Restart(u serviceUnit) error {
	if out, code, err := m.privileged("launchctl", "kickstart", "-k", m.target(u)); err != nil || code != 0 {
		return fmt.Errorf("launchctl kickstart %s: %s", m.target(u), firstNonEmpty(out, errString(err)))
	}
	return nil
}

func (m *launchdManager) Uninstall(u serviceUnit) error {
	m.privileged("launchctl", "bootout", m.target(u)) //nolint:errcheck // already-unloaded is fine
	if m.system {
		if out, code, err := m.r.Run("sudo", "rm", "-f", m.plistPath(u)); err != nil || code != 0 {
			return fmt.Errorf("remove %s: %s", m.plistPath(u), firstNonEmpty(out, errString(err)))
		}
		return nil
	}
	if err := os.Remove(m.plistPath(u)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

var launchdPIDRe = regexp.MustCompile(`(?m)^\s*pid = (\d+)`)
var launchdStateRe = regexp.MustCompile(`(?m)^\s*state = (\S+)`)

func (m *launchdManager) Status(u serviceUnit) (serviceStatus, error) {
	st := serviceStatus{Label: m.label(u)}
	if _, err := os.Stat(m.plistPath(u)); errors.Is(err, os.ErrNotExist) {
		st.State = "not-installed"
		return st, nil
	}
	out, code, err := m.privileged("launchctl", "print", m.target(u))
	if err != nil {
		return st, err
	}
	if code != 0 {
		st.State = "stopped"
		st.Detail = "not loaded"
		return st, nil
	}
	return parseLaunchdPrint(m.label(u), out), nil
}

// parseLaunchdPrint reads `state = running` and `pid = N` out of
// `launchctl print` output.
func parseLaunchdPrint(label, out string) serviceStatus {
	st := serviceStatus{Label: label, State: "stopped"}
	if m := launchdStateRe.FindStringSubmatch(out); m != nil {
		st.State = m[1]
	}
	if m := launchdPIDRe.FindStringSubmatch(out); m != nil {
		st.PID = m[1]
		if _, err := strconv.Atoi(m[1]); err == nil && st.State == "stopped" {
			st.State = "running"
		}
	}
	return st
}

// renderLaunchdPlist writes the plist for one unit. UserName is only valid
// (and only needed) in the system domain, where the label also carries the
// account name (see launchdManager.label).
func renderLaunchdPlist(u serviceUnit, system bool, user string) string {
	label := u.Label
	if system {
		label += "." + user
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
`)
	fmt.Fprintf(&b, "  <key>Label</key><string>%s</string>\n", xmlEscape(label))
	if system {
		fmt.Fprintf(&b, "  <key>UserName</key><string>%s</string>\n", xmlEscape(user))
	}
	b.WriteString("  <key>ProgramArguments</key><array>")
	for _, a := range u.ProgramArgs {
		fmt.Fprintf(&b, "<string>%s</string>", xmlEscape(a))
	}
	b.WriteString("</array>\n  <key>EnvironmentVariables</key><dict>\n")
	for _, k := range sortedEnvKeys(u.Env) {
		fmt.Fprintf(&b, "    <key>%s</key><string>%s</string>\n", xmlEscape(k), xmlEscape(u.Env[k]))
	}
	b.WriteString("  </dict>\n")
	fmt.Fprintf(&b, "  <key>WorkingDirectory</key><string>%s</string>\n", xmlEscape(u.WorkingDir))
	// RunAtLoad + KeepAlive.SuccessfulExit=false: start on load, restart on
	// crash, stay down after a graceful exit. ExitTimeOut stays above the
	// engine's own shutdown deadline (see packaging/launchd/com.ion.engine.plist).
	b.WriteString(`  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>` + strconv.Itoa(int(launchdExitTimeout/time.Second)) + `</integer>
  <key>ProcessType</key><string>Interactive</string>
`)
	fmt.Fprintf(&b, "  <key>StandardOutPath</key><string>%s</string>\n", xmlEscape(u.StdoutPath))
	fmt.Fprintf(&b, "  <key>StandardErrorPath</key><string>%s</string>\n", xmlEscape(u.StderrPath))
	b.WriteString("</dict></plist>\n")
	return b.String()
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return strings.TrimSpace(a)
	}
	return b
}

func errString(err error) string {
	if err == nil {
		return "exit status non-zero"
	}
	return err.Error()
}

// stdinIsTerminal reports whether stdin is a character device (a tty), which
// is what decides whether sudo can prompt for a password.
func stdinIsTerminal() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
